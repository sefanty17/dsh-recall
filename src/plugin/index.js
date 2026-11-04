// Cordis 插件：把 core 包装成 DSH 的 memory 工具 + 常驻上下文 + 后台增量入库。
// 本文件依赖 @deepseek-ai/*，只能在 DSH 里跑；本地用 node --check 验语法。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openDb } from '../core/db.js';
import { ingestSession } from '../core/ingest.js';
import { listSessionFiles, readSessionFile } from '../core/reader.js';
import { listFacts } from '../core/facts.js';
import { createService } from '../core/service.js';
import {
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_PARAMETERS,
} from './tool-spec.js';
import { buildMemoryContext } from './prompt.js';

export const name = 'dsh-recall';
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_DB_PATH = path.join(os.homedir(), '.dsh', 'recall', 'index.db');
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const BOOT_DELAY_MS = 2000;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_MAX_CONTEXT_FACTS = 36;
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 3;

export const Config = z.object({
  dbPath: z.string().default(DEFAULT_DB_PATH),
  sessionsRoot: z.string().default(DEFAULT_SESSIONS_ROOT),
  scanIntervalMs: z.number().default(DEFAULT_SCAN_INTERVAL_MS),
  debounceMs: z.number().default(DEFAULT_DEBOUNCE_MS),
  maxContextFacts: z.number().default(DEFAULT_MAX_CONTEXT_FACTS),
  // 每个入库批次几个会话；1–3，越小单次占用越低
  batchSize: z.number().default(DEFAULT_BATCH_SIZE),
  // 可选：拿不到 agent cwd 时的兜底 scope
  scope: z.string(),
});

function log(message) {
  try {
    console.error(`[dsh-recall] ${message}`);
  } catch {
    // 日志失败也不能影响主流程
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function cwdOfSession(session) {
  const cwd = session?.header?.cwd ?? session?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? cwd : null;
}

/** 路径归一化，用于判断「同一个项目」；Windows 大小写与斜杠不敏感。 */
function scopeKey(value) {
  const text = String(value ?? '').trim().replace(/[\\/]+$/, '');
  if (!text) return '';
  return process.platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text;
}

export function apply(ctx, incomingConfig = {}) {
  const config = {
    dbPath: DEFAULT_DB_PATH,
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxContextFacts: DEFAULT_MAX_CONTEXT_FACTS,
    batchSize: DEFAULT_BATCH_SIZE,
    ...incomingConfig,
  };
  const batchSize = Math.max(
    1,
    Math.min(MAX_BATCH_SIZE, Math.floor(Number(config.batchSize)) || DEFAULT_BATCH_SIZE),
  );

  // (a) 打开数据库
  let db;
  try {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
    // 后台 worker 在写；工具侧写操作等锁而不是立刻失败。
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    log(`打开数据库失败 ${config.dbPath}: ${errorText(error)}`);
    return;
  }

  let selectSessionStates;
  let updateSessionMtime;
  let selectLatestCwd;
  try {
    selectSessionStates = db.prepare('SELECT id, event_count, mtime FROM sessions');
    updateSessionMtime = db.prepare('UPDATE sessions SET mtime = ? WHERE id = ?');
    selectLatestCwd = db.prepare(
      "SELECT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd <> '' " +
        'ORDER BY COALESCE(created_at, 0) DESC, rowid DESC LIMIT 1',
    );
  } catch (error) {
    log(`准备数据库语句失败: ${errorText(error)}`);
    try {
      db.close();
    } catch {
      // ignore
    }
    return;
  }

  let disposed = false;
  let lastScope = null;
  let queue = [];
  let queueRunning = false;
  let rescanRequested = false;
  let scanning = false;
  let scanReason = 'boot';
  let scanIdCounter = 0;
  let pendingScanId = null;
  let batchIndex = 0;
  let totalBatches = 0;
  let totalFiles = 0;
  let doneFiles = 0;
  let queueStartedAt = 0;
  let batchStartedAt = 0;
  let batchTimer = null;
  let intervalTimer = null;
  let worker = null;
  let workerBroken = false;
  let workerBusy = false;
  let inFlightBatch = [];
  const totals = { units: 0, facts: 0, failed: 0 };
  const timers = new Set();
  const debounceTimers = new Map(); // session id -> timer

  const later = (fn, delayMs) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (timer === batchTimer) batchTimer = null;
      try {
        fn();
      } catch (error) {
        log(`定时任务失败: ${errorText(error)}`);
      }
    }, delayMs);
    timers.add(timer);
    return timer;
  };

  const rememberScope = (scope) => {
    if (typeof scope === 'string' && scope.trim()) lastScope = scope;
  };

  /** 当前项目：优先本会话 cwd，其次显式配置，最后用最近一个已入库会话的 cwd 兜底。 */
  function resolvePriorityScope() {
    if (lastScope) return lastScope;
    if (config.scope) return config.scope;
    try {
      return selectLatestCwd.get()?.cwd ?? null;
    } catch {
      return null;
    }
  }

  function loadSessionStates() {
    const states = new Map();
    try {
      for (const row of selectSessionStates.all()) {
        states.set(row.id, {
          eventCount: Number(row.event_count ?? 0),
          mtime: row.mtime == null ? null : Number(row.mtime),
        });
      }
    } catch (error) {
      log(`读取 sessions 状态失败: ${errorText(error)}`);
    }
    return states;
  }

  const isChanged = (file, states) => {
    if (!file?.id || !file?.path) return false;
    const previous = states.get(file.id);
    if (!previous) return true; // 从没入过库
    if (previous.mtime == null) return true; // 旧库补 mtime 前按变更处理一次
    return Number(file.mtime) !== previous.mtime;
  };

  // ---------- 入库 worker（主线程只调度，真正的解码/写库在 worker） ----------

  function disableWorker(reason) {
    if (workerBroken) return;
    workerBroken = true;
    log(`worker 不可用，退回主线程入库：${reason}`);
    const pending = inFlightBatch;
    inFlightBatch = [];
    workerBusy = false;
    const current = worker;
    worker = null;
    if (current) {
      try {
        current.terminate();
      } catch {
        // ignore
      }
    }
    if (pending.length > 0) queue.unshift(...pending);
  }

  function recoverFromWorker(reason) {
    disableWorker(reason);
    if (disposed) return;
    if (scanning) {
      scanning = false;
      pendingScanId = null;
      buildQueueSync(scanReason);
      return;
    }
    if (queueRunning) later(dispatchBatch, 0);
  }

  function ensureWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    if (typeof Worker !== 'function') {
      disableWorker('当前 Node 没有 worker_threads');
      return null;
    }
    try {
      const created = new Worker(new URL('./ingest-worker.js', import.meta.url), {
        workerData: { dbPath: config.dbPath, sessionsRoot: config.sessionsRoot },
      });
      created.unref?.();
      created.on('message', (message) => {
        try {
          onWorkerMessage(message);
        } catch (error) {
          log(`处理 worker 消息失败: ${errorText(error)}`);
        }
      });
      created.on('error', (error) => {
        if (disposed) return;
        recoverFromWorker(errorText(error));
      });
      created.on('exit', (code) => {
        if (disposed) return;
        if (code === 0) {
          if (worker === created) worker = null;
          return;
        }
        recoverFromWorker(`worker 退出 code=${code}`);
      });
      worker = created;
      return worker;
    } catch (error) {
      disableWorker(errorText(error));
      return null;
    }
  }

  function onWorkerMessage(message) {
    if (disposed || !message || typeof message !== 'object') return;

    if (message.type === 'scan-done') {
      if (!scanning || message.scanId !== pendingScanId) return;
      scanning = false;
      pendingScanId = null;
      buildQueueFromFiles(message.files, scanReason);
      return;
    }

    if (message.type === 'scan-failed') {
      if (!scanning || message.scanId !== pendingScanId) return;
      scanning = false;
      pendingScanId = null;
      log(`worker 扫描失败: ${message.error ?? 'unknown'}`);
      disableWorker(message.error ?? '扫描失败');
      buildQueueSync(scanReason);
      return;
    }

    if (message.type === 'fatal') {
      recoverFromWorker(message.error ?? 'worker 初始化失败');
      return;
    }

    if (message.type !== 'batch-done') return;

    const batch = inFlightBatch;
    inFlightBatch = [];
    workerBusy = false;
    const results = Array.isArray(message.results) ? message.results : [];
    let units = 0;
    let facts = 0;
    let failed = 0;
    for (const result of results) {
      const file = batch.find((item) => item.id === result?.id);
      if (result?.error) {
        failed += 1;
        log(`入库失败 ${file?.path ?? result.id}: ${result.error}`);
      } else {
        units += Number(result?.units ?? 0);
        facts += Number(result?.facts ?? 0);
      }
    }
    const ok = Math.max(0, batch.length - failed);
    applyBatchSummary(message.batchId ?? batchIndex, { units, facts, ok, failed }, Date.now() - batchStartedAt);
    if (disposed) return;
    if (queue.length > 0) later(dispatchBatch, 0);
    else finishQueue();
  }

  /** 同步兜底：worker 不可用时，主线程一次也只做 1–3 个会话。 */
  function runSyncBatch(batch) {
    let units = 0;
    let facts = 0;
    let ok = 0;
    let failed = 0;
    for (const file of batch) {
      if (disposed) break;
      try {
        const { header, events } = readSessionFile(file.path);
        const result = ingestSession(db, { header, events });
        units += Number(result?.units ?? 0);
        facts += Number(result?.facts ?? 0);
        updateSessionMtime.run(Math.trunc(Number(file.mtime) || 0), file.id);
        ok += 1;
      } catch (error) {
        failed += 1;
        log(`入库失败 ${file.path}: ${errorText(error)}`);
      }
    }
    return { units, facts, ok, failed };
  }

  function applyBatchSummary(batchId, summary, elapsed) {
    totals.units += summary.units;
    totals.facts += summary.facts;
    totals.failed += summary.failed;
    doneFiles += summary.ok;
    const failed = summary.failed ? ` · 失败 ${summary.failed}` : '';
    log(
      `批次 ${batchId}/${totalBatches} · 会话 ${doneFiles}/${totalFiles}` +
        ` · units ${summary.units} · facts ${summary.facts}${failed} · ${elapsed}ms`,
    );
  }

  function finishQueue() {
    if (!queueRunning || workerBusy) return;
    const elapsed = Date.now() - queueStartedAt;
    const failed = totals.failed ? ` · 失败 ${totals.failed}` : '';
    log(
      `本轮入库完成：${doneFiles}/${totalFiles} 个会话` +
        ` · units ${totals.units} · facts ${totals.facts}${failed}` +
        ` · ${batchIndex} 批 · ${elapsed}ms`,
    );
    queue = [];
    queueRunning = false;
    batchIndex = 0;
    totalBatches = 0;
    totalFiles = 0;
    doneFiles = 0;
    queueStartedAt = 0;
    totals.units = 0;
    totals.facts = 0;
    totals.failed = 0;
    if (rescanRequested && !disposed) {
      rescanRequested = false;
      later(() => requestScan('rescan'), 500);
    }
  }

  /** 一批 1–3 个会话交给 worker；批与批之间 setTimeout(0) 让出事件循环。 */
  function dispatchBatch() {
    if (disposed || !queueRunning) return;
    if (queue.length === 0) {
      if (!workerBusy) finishQueue();
      return;
    }
    if (workerBusy) return;

    const batch = queue.splice(0, batchSize);
    batchIndex += 1;
    batchStartedAt = Date.now();
    const active = ensureWorker();

    if (active) {
      inFlightBatch = batch;
      workerBusy = true;
      try {
        active.postMessage({
          type: 'batch',
          batchId: batchIndex,
          jobs: batch.map((file) => ({ id: file.id, path: file.path, mtime: file.mtime })),
        });
      } catch (error) {
        workerBusy = false;
        inFlightBatch = [];
        queue.unshift(...batch);
        disableWorker(errorText(error));
        later(dispatchBatch, 0);
      }
      return;
    }

    // worker 建不起来：退回主线程，仍然一批 1–3 个。
    const summary = runSyncBatch(batch);
    applyBatchSummary(batchIndex, summary, Date.now() - batchStartedAt);
    later(dispatchBatch, 0);
  }

  /** 扫描结果 → 只挑没入库 / mtime 变过的文件 → 当前项目优先、小文件优先。 */
  function buildQueueFromFiles(files, reason) {
    scanning = false;
    if (disposed || queueRunning) {
      if (queueRunning) rescanRequested = true;
      return;
    }
    queueRunning = true;
    try {
      if (!Array.isArray(files)) throw new Error('listSessionFiles 没有返回数组');
      const states = loadSessionStates();
      const changed = files.filter((file) => isChanged(file, states));
      const priorityScope = resolvePriorityScope();
      const priorityKey = scopeKey(priorityScope);

      changed.sort((a, b) => {
        if (priorityKey) {
          const aPriority = scopeKey(a.cwd) === priorityKey ? 0 : 1;
          const bPriority = scopeKey(b.cwd) === priorityKey ? 0 : 1;
          if (aPriority !== bPriority) return aPriority - bPriority;
        }
        return (Number(a.size) || 0) - (Number(b.size) || 0);
      });

      if (changed.length === 0) {
        queueRunning = false;
        if (reason !== 'interval') {
          log(`扫描（${reason}）：${files.length} 个会话文件，无变化`);
        }
        if (rescanRequested && !disposed) {
          rescanRequested = false;
          later(() => requestScan('rescan'), 500);
        }
        return;
      }

      queue = changed;
      totalFiles = changed.length;
      totalBatches = Math.ceil(changed.length / batchSize);
      batchIndex = 0;
      doneFiles = 0;
      queueStartedAt = Date.now();
      totals.units = 0;
      totals.facts = 0;
      totals.failed = 0;

      log(
        `扫描（${reason}）：${files.length} 个会话文件，${changed.length} 个待入库` +
          (priorityScope ? `，优先 ${priorityScope}` : ''),
      );
      batchTimer = later(dispatchBatch, 0);
    } catch (error) {
      queueRunning = false;
      log(`扫描失败（${reason}）: ${errorText(error)}`);
    }
  }

  /** worker 不可用时的同步扫描兜底（会占用主线程几百毫秒）。 */
  function buildQueueSync(reason) {
    if (disposed || queueRunning) {
      if (queueRunning) rescanRequested = true;
      return;
    }
    try {
      const files = listSessionFiles(config.sessionsRoot);
      buildQueueFromFiles(files, reason);
    } catch (error) {
      scanning = false;
      queueRunning = false;
      log(`扫描失败（${reason}）: ${errorText(error)}`);
    }
  }

  function requestScan(reason) {
    if (disposed) return;
    if (queueRunning || scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    scanReason = reason;
    // 目录扫描（listSessionFiles 会解码 256 个 header，约 0.8s）也放到 worker，
    // 否则每次 60s 扫描都会卡主线程。
    const active = ensureWorker();
    if (active) {
      scanIdCounter += 1;
      pendingScanId = scanIdCounter;
      try {
        active.postMessage({
          type: 'scan',
          scanId: pendingScanId,
          sessionsRoot: config.sessionsRoot,
        });
      } catch (error) {
        scanning = false;
        pendingScanId = null;
        disableWorker(errorText(error));
        buildQueueSync(reason);
      }
      return;
    }
    scanning = false;
    buildQueueSync(reason);
  }

  // (b) 注册唯一工具 memory
  try {
    ctx.tools.register(
      defineTool({
        name: MEMORY_TOOL_NAME,
        description: MEMORY_TOOL_DESCRIPTION,
        parameters: MEMORY_TOOL_PARAMETERS,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        execute: async (args = {}, exec) => {
          const cwd = exec?.agent?.session?.header?.cwd;
          rememberScope(cwd);
          const scope = args.scope ?? cwd ?? config.scope ?? 'global';
          try {
            const service = createService({ db, scope });
            switch (args.action) {
              case 'state':
                return await service.state();
              case 'history':
                return await service.history(args.key);
              case 'search':
                return await service.search(args.query, { limit: args.limit });
              case 'read':
                return await service.read(args.session_id ?? args.sessionId, args.seq);
              case 'write':
                return await service.write(args.content);
              default:
                return `[memory] 未知 action: ${String(args.action)}；可用：state / history / search / read / write`;
            }
          } catch (error) {
            log(`工具 ${String(args.action)} 失败: ${errorText(error)}`);
            return `[memory.error] ${String(args.action)} 失败：${errorText(error)}`;
          }
        },
      }),
    );
  } catch (error) {
    log(`注册 memory 工具失败: ${errorText(error)}`);
    try {
      db.close();
    } catch {
      // ignore
    }
    return;
  }

  // (c) 常驻上下文：scope 取当前 agent 的 cwd，拿不到就不输出
  try {
    ctx.systemPrompt.context({
      name: 'dsh-recall',
      order: 900,
      interpolate: false,
      text: (promptContext) => {
        if (disposed) return '';
        // DSH 传入的 context 形如 { agent, scope: agent, signal }，逐层兜底。
        const agent = promptContext?.agent ?? promptContext?.scope;
        const scope =
          cwdOfSession(agent?.session) ??
          cwdOfSession(promptContext?.session) ??
          agent?.cwd ??
          promptContext?.cwd ??
          lastScope ??
          config.scope ??
          null;
        if (!scope) return '';
        try {
          const facts = listFacts(db, { scope, status: 'active' });
          return buildMemoryContext({
            facts,
            scope,
            maxFacts: config.maxContextFacts,
          });
        } catch (error) {
          log(`构建常驻上下文失败: ${errorText(error)}`);
          return '';
        }
      },
    });
  } catch (error) {
    log(`注册常驻上下文失败: ${errorText(error)}`);
  }

  // (d) 启动 2s 后开始分片入库；之后按间隔扫描
  later(() => requestScan('boot'), BOOT_DELAY_MS);
  intervalTimer = setInterval(
    () => requestScan('interval'),
    Math.max(5_000, Number(config.scanIntervalMs) || DEFAULT_SCAN_INTERVAL_MS),
  );

  // 会话事件：按 session 防抖后触发增量扫描
  try {
    ctx.on('session/event', (session, event) => {
      try {
        rememberScope(cwdOfSession(session));
        const id = session?.id ?? event?.session_id ?? 'unknown';
        const previous = debounceTimers.get(id);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => {
          debounceTimers.delete(id);
          requestScan('event');
        }, Math.max(1_000, Number(config.debounceMs) || DEFAULT_DEBOUNCE_MS));
        debounceTimers.set(id, timer);
      } catch (error) {
        log(`处理 session/event 失败: ${errorText(error)}`);
      }
    });
  } catch (error) {
    log(`监听 session/event 失败: ${errorText(error)}`);
  }

  // (e) 卸载时清理
  ctx.effect(() => () => {
    disposed = true;
    if (intervalTimer) clearInterval(intervalTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    const current = worker;
    worker = null;
    if (current) {
      try {
        current.postMessage({ type: 'close' });
      } catch {
        // ignore
      }
      try {
        current.terminate();
      } catch {
        // ignore
      }
    }
    try {
      db.close();
    } catch (error) {
      log(`关闭数据库失败: ${errorText(error)}`);
    }
  });
}
