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
import { chatJson, resolveLlmConfig } from '../core/llm.js';
import {
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_PARAMETERS,
} from './tool-spec.js';
import { composeMemoryContext } from './prompt.js';
import {
  buildInjectionSync,
  createInjectionCache,
  DEFAULT_SELECTOR_TIMEOUT_MS,
  resolveInjection,
} from './inject.js';

export const name = 'dsh-recall';
// 注意：cordis 的 inject 只支持「数组」或「服务名 → intercept 配置」两种形状，
// 没有 { required, optional }。所以 sessionQuery 不能写进 inject（缺席时插件会
// 永远停在 pending）；改成调用时用 ctx.get('sessionQuery') 做可选读取。
export const inject = ['tools', 'systemPrompt'];

const DEFAULT_DB_PATH = path.join(os.homedir(), '.dsh', 'recall', 'index.db');
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const BOOT_DELAY_MS = 2000;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_MAX_CONTEXT_FACTS = 36;
const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 3;
const DEFAULT_MAX_TOPICS = 8;
const DEFAULT_THRESHOLD = 0.58;
const DEFAULT_LEXICAL_THRESHOLD = 0.55;
const DEFAULT_MAX_INJECT_LINES = 200;
/** 默认开启选择器注入（system-prompt/assemble async waterfall）。 */
const DEFAULT_SELECTOR_INJECTION = true;
/** 原生 session-query 调用的超时；超时/报错都静默回退本地。 */
const NATIVE_TIMEOUT_MS = 3_000;
/** 原生 read 返回的原始 JSON 上限，防止一个巨大 tool result 撑爆上下文。 */
const MAX_RAW_JSON_CHARS = 12_000;
/** 当前问题缓存的有效期；超过说明这个 turn 早已结束，不再用它注入。 */
const QUESTION_TTL_MS = 30 * 60_000;

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
  // v2 地图层注入：主题召回阈值 / 数量 / 行数上限
  maxTopics: z.number().default(DEFAULT_MAX_TOPICS),
  threshold: z.number().default(DEFAULT_THRESHOLD),
  lexicalThreshold: z.number().default(DEFAULT_LEXICAL_THRESHOLD),
  maxInjectLines: z.number().default(DEFAULT_MAX_INJECT_LINES),
  // true：每轮在 system-prompt/assemble 里跑选择器（超时退回同步）；
  // false：只在同步 context 里做词法注入。
  selectorInjection: z.boolean().default(DEFAULT_SELECTOR_INJECTION),
  selectorTimeoutMs: z.number().default(DEFAULT_SELECTOR_TIMEOUT_MS),
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

// ---------------------------------------------------------------------------
// 原生 session-query：可选服务 + 文本格式化
// 服务名、方法名与请求形状以 @deepseek-ai/dsh-session-query（及 -sqlite）为准：
//   readEvent({ sessionId, seq, before?, after? }, signal)
//   traceSession(sessionId, signal) / traceEvent({ sessionId, seq }, signal)
//   searchSessions({ query, sessionFilters?, limit? }, { signal })
// ---------------------------------------------------------------------------

/** 可选读取 sessionQuery；服务缺席 / 未激活都返回 null，不影响插件加载。 */
function sessionQueryOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? (ctx.get('sessionQuery') ?? null) : null;
  } catch {
    return null;
  }
}

/** 3s 超时；超时由 AbortSignal 触发，调用方统一按失败处理。 */
function withNativeTimeout() {
  try {
    return AbortSignal.timeout(NATIVE_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

function collapseText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '—';
  }
}

/** 消息 content 块 → 纯文本；reasoning 也保留（原生 read 的价值就在这里）。 */
function blocksText(content, { reasoning = false } = {}) {
  const blocks = Array.isArray(content) ? content : [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (reasoning && block.type === 'reasoning' && typeof block.text === 'string') {
      parts.push(`[reasoning] ${block.text}`);
    } else if (block.type === 'tool-call' && typeof block.name === 'string') {
      parts.push(`[tool-call ${block.name}]`);
    }
  }
  return parts.join('\n');
}

/** 用户消息（inbox 里的 UserMessage 或 session 事件的 data）→ 问题文本。 */
function userMessageText(message) {
  return collapseText(blocksText(message?.content)).slice(0, 500);
}

/** 最近一条真实用户消息；跳过 runtime-context 快照和工具注入。 */
function lastUserQuestion(target) {
  const session = target?.session ?? target;
  let events;
  try {
    events = session?.snapshotEvents?.();
  } catch {
    return '';
  }
  if (!Array.isArray(events)) return '';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    const text = userMessageText(event.data);
    if (text) return text;
  }
  return '';
}

/**
 * 按权威 surface 取最后一条用户消息（不再扫全量日志）。
 * surface.nodes 是当前模型可见节点；事件正文用 eventAt(seq) 读。
 * 取不到返回 null（调用方决定是走 claim 缓存还是放弃注入）。
 */
function lastUserMessageText(session) {
  try {
    const nodes = session?.surface?.nodes;
    if (!nodes || typeof session?.eventAt !== 'function') return null;
    const seqs = Array.from(nodes).sort((a, b) => Number(a) - Number(b));
    for (let i = seqs.length - 1; i >= 0; i -= 1) {
      const event = session.eventAt(seqs[i]);
      if (event?.type !== 'user/message') continue;
      // runtime-context 快照也是 user/message，会自指，必须跳过
      if (event.data?.source?.kind === 'runtime-context') continue;
      const text = userMessageText(event.data);
      if (text) return text;
    }
  } catch {
    // 落到 null
  }
  return null;
}

/** 当前 turn 号：surface 里最后一条 turn/start；取不到返回 0。 */
function currentTurnOf(session) {
  try {
    const nodes = session?.surface?.nodes;
    if (!nodes || typeof session?.eventAt !== 'function') return 0;
    const seqs = Array.from(nodes).sort((a, b) => Number(a) - Number(b));
    for (let i = seqs.length - 1; i >= 0; i -= 1) {
      const event = session.eventAt(seqs[i]);
      if (event?.type !== 'turn/start') continue;
      const turn = Number(event.data?.turn);
      return Number.isFinite(turn) ? turn : 0;
    }
  } catch {
    // ignore
  }
  return 0;
}

/** 事件正文（只用于 read 的前后邻域摘要）。 */
function eventText(event) {
  const data = event?.data;
  switch (event?.type) {
    case 'user/message': return blocksText(data?.content);
    case 'assistant/message': return blocksText(data?.message?.content);
    case 'tool/call': return [data?.name, data?.arguments].filter((v) => typeof v === 'string' && v).join('\n');
    case 'tool/result': return blocksText(data?.message?.content);
    default: return '';
  }
}

function formatNeighborEvent(event) {
  const text = collapseText(eventText(event));
  const head = `- seq ${event?.seq ?? '?'} | ${event?.type ?? 'unknown'} | ${toIso(event?.time)}`;
  if (!text) return head;
  return `${head}\n  ${text.slice(0, 600).replaceAll('\n', '\n  ')}`;
}

function formatRawJson(value) {
  let json;
  try {
    json = JSON.stringify(value ?? null, null, 2);
  } catch {
    json = '"（原始事件无法序列化）"';
  }
  if (typeof json !== 'string') json = String(json);
  if (json.length > MAX_RAW_JSON_CHARS) {
    return `${json.slice(0, MAX_RAW_JSON_CHARS - 16)}\n…（JSON 已截断）`;
  }
  return json;
}

/** readEvent 的 window → 模型可读文本：目标事件原始 JSON + 前后邻域。 */
function formatNativeEventRead(window, sessionId, seq) {
  const targetSeq = Math.trunc(Number(seq));
  const events = Array.isArray(window?.events) ? window.events : [];
  const lines = [
    `[memory.read] session=${sessionId} seq=${targetSeq} · native · raw JSON（含 reasoning）`,
    '```json',
    formatRawJson(window?.target ?? null),
    '```',
  ];
  const before = events.filter((event) => Number(event?.seq) < targetSeq);
  const after = events.filter((event) => Number(event?.seq) > targetSeq);
  if (before.length > 0) {
    lines.push('', 'Before:');
    for (const event of before) lines.push(formatNeighborEvent(event));
  }
  if (after.length > 0) {
    lines.push('', 'After:');
    for (const event of after) lines.push(formatNeighborEvent(event));
  }
  return lines.join('\n');
}

function availabilityOf(record) {
  const parts = [];
  if (record?.live) parts.push('live');
  if (record?.persisted) parts.push('persisted');
  return parts.length > 0 ? parts.join(', ') : 'unavailable';
}

function renderTraceDescendants(lines, nodes, depth) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const record = node?.session ?? node;
    const indent = '  '.repeat(Math.max(0, depth));
    lines.push(
      `${indent}- ${record?.header?.id ?? '?'} | ${toIso(record?.header?.createdAt)} | ${availabilityOf(record)}`,
    );
    renderTraceDescendants(lines, node?.descendants ?? [], depth + 1);
  }
}

/** traceSession 的返回值 → 模型可读的会话血缘。 */
function formatNativeSessionTrace(trace, sessionId) {
  const ancestors = Array.isArray(trace?.ancestors) ? trace.ancestors : [];
  const descendants = Array.isArray(trace?.descendants) ? trace.descendants : [];
  const lines = [
    `[memory.trace] session=${sessionId} · native · session lineage`,
    `Created: ${toIso(trace?.target?.header?.createdAt)}`,
    `Availability: ${availabilityOf(trace?.target)}`,
    '',
    'Ancestors (nearest first):',
  ];
  if (ancestors.length === 0) {
    lines.push(trace?.complete === false ? '- [ancestor boundary]' : '- none (root session)');
  }
  for (const record of ancestors) {
    lines.push(`- ${record?.header?.id ?? '?'} | ${toIso(record?.header?.createdAt)} | ${availabilityOf(record)}`);
  }
  lines.push('', 'Descendants:');
  if (descendants.length === 0) lines.push('- none');
  else renderTraceDescendants(lines, descendants, 0);
  if (trace?.complete === false) lines.push('', '（血缘不完整：有祖先无法解析）');
  return lines.join('\n');
}

function seqListOf(values) {
  const list = Array.isArray(values) ? values : [];
  return list.length > 0 ? list.join(', ') : 'none';
}

/** traceEvent 的返回值 → 模型可读的事件关系。 */
function formatNativeEventTrace(trace, sessionId, seq) {
  return [
    `[memory.trace] session=${sessionId} seq=${Math.trunc(Number(seq))} · native · event trace`,
    `Target: seq ${trace?.target?.seq ?? seq} | ${trace?.target?.type ?? '?'} | ${trace?.target?.surface ?? '?'} | ${toIso(trace?.target?.time)}`,
    `Replaced by: ${trace?.replacedBy ?? 'none'}`,
    `Replacement chain: ${seqListOf(trace?.replacementChain)}`,
    `Events replaced by target: ${seqListOf(trace?.replacedEventSeqs)}`,
    `Events cited directly as sources: ${seqListOf(trace?.sourceEventSeqs)}`,
    `Direct derived events: ${seqListOf(trace?.derivedEventSeqs)}`,
    `Session created: ${toIso(trace?.session?.createdAt)}`,
  ].join('\n');
}

/** searchSessions 的命中 → 带下钻提示的结果；头部必须标 fallback=native。 */
function formatNativeSearch(page, scope) {
  const items = Array.isArray(page?.items) ? page.items : [];
  const lines = [`[memory.search] fallback=native · ${items.length} ${items.length === 1 ? 'hit' : 'hits'} · scope=${scope}`];
  for (let i = 0; i < items.length; i += 1) {
    const hit = items[i];
    const best = hit?.bestMatch ?? {};
    lines.push(
      `${i + 1}. session=${hit?.header?.id ?? best.sessionId ?? '?'} · ${toIso(hit?.header?.createdAt)}`,
      `   Best match: seq ${best.seq ?? '?'} | ${best.type ?? '?'} | ${best.surface ?? '?'} | ${toIso(best.time)}`,
      `   Snippet: ${collapseText(best.snippet).slice(0, 300) || '（空）'}`,
      `→ 下钻：memory(action="read", session_id="${hit?.header?.id ?? best.sessionId ?? ''}", seq=${best.seq ?? 0})`,
    );
  }
  if (page?.capped) lines.push('', '（结果达到上限，缩小 query 或 scope 再试）');
  return lines.join('\n');
}

/** v1 search 的空结果文案（format.js 冻结）；只用来决定要不要回退原生。 */
function isEmptySearchResult(text) {
  return typeof text === 'string' && /^\[memory\.search\] 0 hits/m.test(text);
}

/** 当前 agent 可见工具名（给选择器当提示；拿不到就空数组）。 */
function activeToolNames(ctx, exec) {
  try {
    const view = ctx?.tools?.view?.(exec?.agent);
    return view?.visible ? [...view.visible.keys()] : [];
  } catch {
    return [];
  }
}

function formatRecallResult(result) {
  const topics = Array.isArray(result?.topicsUsed) ? result.topicsUsed.length : 0;
  const spans = Array.isArray(result?.spansUsed) ? result.spansUsed.length : 0;
  const skip = result?.skipped ? ` · skipped=${result.skipped}` : '';
  const header = `[memory.recall] topics=${topics} spans=${spans}${skip}`;
  return result?.text ? `${header}\n${result.text}` : `${header}\n（没有足够相关的记忆）`;
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------


export function apply(ctx, incomingConfig = {}) {
  const config = {
    dbPath: DEFAULT_DB_PATH,
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    scanIntervalMs: DEFAULT_SCAN_INTERVAL_MS,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxContextFacts: DEFAULT_MAX_CONTEXT_FACTS,
    batchSize: DEFAULT_BATCH_SIZE,
    maxTopics: DEFAULT_MAX_TOPICS,
    threshold: DEFAULT_THRESHOLD,
    lexicalThreshold: DEFAULT_LEXICAL_THRESHOLD,
    maxInjectLines: DEFAULT_MAX_INJECT_LINES,
    selectorInjection: DEFAULT_SELECTOR_INJECTION,
    selectorTimeoutMs: DEFAULT_SELECTOR_TIMEOUT_MS,
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
  // session id -> { text, at }：agent/inbox/claimed 在 preStep 组装提示词之前触发，
  // 是拿到「本轮问题」的唯一可靠时机（step 里才把 user/message 写进 session）。
  const pendingQuestions = new Map();
  // `${sessionId}:${turn}` -> 注入结果；同一 turn 的多次 assemble 只跑一次选择器。
  const injectionCache = createInjectionCache({ maxEntries: 128 });

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

  // (b) 原生 session-query 的可选能力：拿不到服务就返回 null / 提示，不抛
  /** 原生 read：3s 超时；拿不到、报错、超时都返回 null，由调用方回退本地。 */
  async function tryNativeRead(sessionQuery, sessionId, seq) {
    if (!sessionQuery || typeof sessionQuery.readEvent !== 'function') return null;
    try {
      const window = await sessionQuery.readEvent(
        { sessionId, seq, before: 1, after: 1 },
        withNativeTimeout(),
      );
      if (!window || !window.target) return null;
      return formatNativeEventRead(window, sessionId, seq);
    } catch (error) {
      log(`原生 readEvent 失败，回退本地 events.text: ${errorText(error)}`);
      return null;
    }
  }

  /** 原生 search：仅 v1 unit 检索为空时调用；索引不可用/超时返回 null。 */
  async function tryNativeSearch(sessionQuery, query, scope, limit) {
    if (!sessionQuery || typeof sessionQuery.searchSessions !== 'function') return null;
    const q = String(query ?? '').trim();
    if (!q) return null;
    try {
      const request = { query: q };
      if (scope && scope !== 'global') {
        request.sessionFilters = [{ kind: 'cwd', values: [scope] }];
      }
      const wanted = Math.floor(Number(limit));
      request.limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, 20) : 8;
      const page = await sessionQuery.searchSessions(request, { signal: withNativeTimeout() });
      if (!Array.isArray(page?.items) || page.items.length === 0) return null;
      return formatNativeSearch(page, scope || 'global');
    } catch (error) {
      log(`原生 searchSessions 失败: ${errorText(error)}`);
      return null;
    }
  }

  /** 原生 trace：给了 seq 走 traceEvent，否则走 traceSession（session_trace 等价）。 */
  async function tryNativeTrace(sessionQuery, sessionId, seq) {
    try {
      if (Number.isFinite(Number(seq)) && typeof sessionQuery.traceEvent === 'function') {
        const trace = await sessionQuery.traceEvent(
          { sessionId, seq: Math.trunc(Number(seq)) },
          withNativeTimeout(),
        );
        return trace ? formatNativeEventTrace(trace, sessionId, seq) : null;
      }
      if (typeof sessionQuery.traceSession === 'function') {
        const trace = await sessionQuery.traceSession(sessionId, withNativeTimeout());
        return trace ? formatNativeSessionTrace(trace, sessionId) : null;
      }
      return null;
    } catch (error) {
      log(`原生 trace 失败: ${errorText(error)}`);
      return null;
    }
  }

  /** recall / waterfall 注入用的 complete；没有凭据返回 null。 */
  function llmComplete(timeoutMs = 15_000) {
    try {
      const llm = resolveLlmConfig(process.env);
      if (!llm.available) return null;
      const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Math.floor(Number(timeoutMs))
        : 15_000;
      return (messages) => chatJson({
        messages,
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        model: llm.model,
        timeoutMs: Math.max(500, budget),
        maxRetries: 0,
      });
    } catch {
      return null;
    }
  }

  /**
   * system-prompt/assemble 的异步注入：每 turn 跑一次选择器（结果缓存），
   * 超时/报错退回同步词法；返回最终文本（可能为空串）。
   */
  async function buildSelectorInjection(agent, session, scope) {
    const question = currentQuestion(agent, { session });
    if (!question) return '';
    const timeoutMs = Number.isFinite(Number(config.selectorTimeoutMs)) && Number(config.selectorTimeoutMs) > 0
      ? Math.floor(Number(config.selectorTimeoutMs))
      : DEFAULT_SELECTOR_TIMEOUT_MS;
    const result = await resolveInjection({
      db,
      scope,
      question,
      activeTools: activeToolNames(ctx, { agent }),
      complete: llmComplete(timeoutMs),
      maxTopics: config.maxTopics,
      threshold: config.lexicalThreshold,
      maxLines: config.maxInjectLines,
      timeoutMs,
      cache: injectionCache,
      cacheKey: `${session.id}:${currentTurnOf(session)}`,
    });
    return result?.text || '';
  }

  /** recall：选择器路径；选择器没结果时退回同步词法结果，别空手而归。 */
  async function recallMemory({ scope, question, activeTools }) {
    const base = {
      db,
      scope,
      question,
      maxTopics: config.maxTopics,
      threshold: config.lexicalThreshold,
      maxLines: config.maxInjectLines,
    };
    const timeoutMs = 20_000;
    const injection = await resolveInjection({
      ...base,
      activeTools,
      complete: llmComplete(timeoutMs),
      timeoutMs,
    });
    if (injection.text) return formatRecallResult(injection);
    const fallback = buildInjectionSync(base);
    if (fallback.text) {
      return formatRecallResult({ ...fallback, skipped: injection.skipped ?? 'no-selector' });
    }
    return formatRecallResult(injection);
  }

  // (c) 注册唯一工具 memory
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
            const sessionQuery = sessionQueryOf(ctx);
            switch (args.action) {
              case 'state':
                return await service.state();
              case 'history':
                return await service.history(args.key);
              case 'search': {
                const result = await service.search(args.query, { limit: args.limit });
                if (!isEmptySearchResult(result)) return result;
                const native = await tryNativeSearch(sessionQuery, args.query, scope, args.limit);
                return native ?? result;
              }
              case 'read': {
                const sessionId = args.session_id ?? args.sessionId;
                const seq = Number(args.seq);
                if (sessionId != null && String(sessionId).trim() && Number.isFinite(seq)) {
                  const native = await tryNativeRead(sessionQuery, String(sessionId).trim(), seq);
                  if (native) return native;
                }
                return await service.read(sessionId, args.seq);
              }
              case 'trace': {
                const sessionId = String(args.session_id ?? exec?.agent?.session?.id ?? '').trim();
                if (!sessionId) return '[memory.trace] 需要 session_id（当前会话没有 id）';
                if (!sessionQuery) return '[memory.trace] 原生 session-query 不可用';
                const hasSeq = Number.isFinite(Number(args.seq));
                const supported = hasSeq
                  ? typeof sessionQuery.traceEvent === 'function'
                  : typeof sessionQuery.traceSession === 'function';
                if (!supported) return '[memory.trace] 原生 session-query 不可用';
                const native = await tryNativeTrace(sessionQuery, sessionId, args.seq);
                return native ?? '[memory.trace] 原生 session-query 调用失败（可稍后重试）';
              }
              case 'recall': {
                const question = String(args.question ?? args.query ?? '').trim();
                if (!question) return '[memory.error] recall: 需要 question';
                return await recallMemory({ scope, question, activeTools: activeToolNames(ctx, exec) });
              }
              case 'write':
                return await service.write(args.content);
              default:
                return `[memory] 未知 action: ${String(args.action)}；可用：state / history / search / read / write / trace / recall`;
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

  // (d) 常驻上下文：selectorInjection=false 时放状态表 + 同步词法注入；否则只放状态表
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
          let injection = '';
          // selectorInjection=true 时异步 waterfall 负责注入，同步 context 只放状态表，
          // 避免同一份相关记忆出现两次。
          if (!config.selectorInjection) {
            try {
              const question = currentQuestion(agent, promptContext);
              if (question) {
                injection = buildInjectionSync({
                  db,
                  scope,
                  question,
                  maxTopics: config.maxTopics,
                  threshold: config.lexicalThreshold,
                  maxLines: config.maxInjectLines,
                }).text;
              }
            } catch (error) {
              // 注入失败不能影响状态表本身
              log(`构建记忆注入失败: ${errorText(error)}`);
            }
          }
          return composeMemoryContext({
            facts,
            scope,
            maxFacts: config.maxContextFacts,
            injection,
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

  // (e) 异步注入：system-prompt/assemble 是 async waterfall（context.text 不是）。
  // 每 turn 首次 assemble 跑选择器，结果按 sessionId:turn 缓存；超时/异常退回
  // 同步词法，任何情况都不能把异常抛给组装流水线。
  if (config.selectorInjection) {
    try {
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next();
        try {
          if (disposed) return assembly;
          const agent = context?.agent;
          if (!agent) return assembly;
          const session = agent.session;
          if (!session?.id) return assembly;
          const scope =
            cwdOfSession(session) ??
            agent?.cwd ??
            lastScope ??
            config.scope ??
            null;
          if (!scope) return assembly;
          const text = await buildSelectorInjection(agent, session, scope);
          if (!text) return assembly;
          const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : [];
          return {
            ...assembly,
            contexts: [
              ...contexts,
              { name: 'dsh-recall:injection', text, interpolate: false },
            ],
          };
        } catch (error) {
          log(`异步注入失败（不影响组装）: ${errorText(error)}`);
          return assembly;
        }
      }, { prepend: true });
    } catch (error) {
      log(`注册异步注入失败: ${errorText(error)}`);
    }
  }

  /** 本轮问题：优先 claim 缓存（比 session 日志早），退回 surface / 日志里的用户消息。 */
  function currentQuestion(agent, promptContext) {
    try {
      const session = agent?.session ?? promptContext?.session;
      const sessionId = session?.id;
      if (sessionId) {
        const cached = pendingQuestions.get(sessionId);
        if (cached && Date.now() - cached.at <= QUESTION_TTL_MS) return cached.text;
      }
      return lastUserMessageText(session) || lastUserQuestion(agent) || '';
    } catch {
      return '';
    }
  }

  // (f) 启动 2s 后开始分片入库；之后按间隔扫描
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
        // turn 结束就清掉「本轮问题」和注入缓存，避免下一轮（如 goal 续跑）复用旧结果。
        if (event?.type === 'turn/end') {
          pendingQuestions.delete(id);
          injectionCache.deleteByPrefix(`${id}:`);
        }
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

  // (g) 本轮问题：claim 在 preStep 组装提示词之前触发（step 里才写 session 日志）
  try {
    ctx.on('agent/inbox/claimed', (subject, payload) => {
      try {
        const agent = payload?.agent ?? subject?.agent ?? subject;
        const sessionId = agent?.session?.id ?? agent?.id;
        if (!sessionId) return;
        // 只缓存真实用户输入；goal/compaction 等合成消息不当作「本轮问题」。
        if (payload?.message?.source?.kind !== 'user') return;
        const text = userMessageText(payload?.message);
        if (!text) return;
        pendingQuestions.set(sessionId, { text, at: Date.now() });
        // 新输入（含 steer）可能改变问题 → 该会话的 turn 注入缓存全部失效。
        injectionCache.deleteByPrefix(`${sessionId}:`);
        // 简单上限，避免长期运行积累已结束会话的问题
        while (pendingQuestions.size > 128) {
          const oldest = pendingQuestions.keys().next().value;
          if (oldest === undefined) break;
          pendingQuestions.delete(oldest);
        }
      } catch (error) {
        log(`处理 agent/inbox/claimed 失败: ${errorText(error)}`);
      }
    });
  } catch (error) {
    log(`监听 agent/inbox/claimed 失败: ${errorText(error)}`);
  }

  // (h) 卸载时清理
  ctx.effect(() => () => {
    disposed = true;
    pendingQuestions.clear();
    injectionCache.clear();
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
