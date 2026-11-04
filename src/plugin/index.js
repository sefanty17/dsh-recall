// Cordis 插件：memory 工具（search / recall / read / trace）+ 常驻指令 + 每轮注入 + 后台整理。
// 依赖 @deepseek-ai/*，只能在 DSH 里跑；本地用 node --check 验语法。
// sessionQuery 不写进 inject（缺席会让插件 pending），调用时用 ctx.get 可选读取。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openDb } from '../core/db.js';
import { listSessionFiles, readSessionFile } from '../core/reader.js';
import { retrieveSpans } from '../core/retrieve.js';
import { resolveRerankConfig } from '../core/rerank.js';
import { curateSession } from '../core/curator.js';
import { chatJson, resolveLlmConfig } from '../core/llm.js';
import { embedTexts, resolveEmbeddingConfig } from '../core/vectors.js';
import { MEMORY_INSTRUCTION, MEMORY_TOOL_DESCRIPTION, MEMORY_TOOL_NAME, MEMORY_TOOL_PARAMETERS, } from './tool-spec.js';
import { buildInjectionSync, createInjectionCache, DEFAULT_SELECTOR_TIMEOUT_MS, resolveInjection, } from './inject.js';
export const name = 'dsh-recall';
export const inject = ['tools', 'systemPrompt'];
const DEFAULT_DB_PATH = path.join(os.homedir(), '.dsh', 'recall', 'index.db');
const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const DEFAULT_SPAN_EVERY_TURNS = 5;
const DEFAULT_TURNS_PER_BATCH = 5;
const DEFAULT_MAX_TOPICS = 8;
const DEFAULT_THRESHOLD = 0.58;
const DEFAULT_LEXICAL_THRESHOLD = 0.55;
const DEFAULT_MAX_INJECT_LINES = 200;
const DEFAULT_SELECTOR_INJECTION = true;
const DEFAULT_RERANK_BACKEND = 'none';
const DEFAULT_RERANK_TOP_N = 0;
const NATIVE_TIMEOUT_MS = 3_000;
const CURATION_TIMEOUT_MS = 60_000;
const MAX_RAW_JSON_CHARS = 12_000;
const QUESTION_TTL_MS = 30 * 60_000;
export const Config = z.object({
  dbPath: z.string().default(DEFAULT_DB_PATH),
  sessionsRoot: z.string().default(DEFAULT_SESSIONS_ROOT),
  scope: z.string(),
  spanEveryTurns: z.number().default(DEFAULT_SPAN_EVERY_TURNS),
  turnsPerBatch: z.number().default(DEFAULT_TURNS_PER_BATCH),
  topicDir: z.string(),
  maxTopics: z.number().default(DEFAULT_MAX_TOPICS),
  threshold: z.number().default(DEFAULT_THRESHOLD),
  lexicalThreshold: z.number().default(DEFAULT_LEXICAL_THRESHOLD),
  maxInjectLines: z.number().default(DEFAULT_MAX_INJECT_LINES),
  selectorInjection: z.boolean().default(DEFAULT_SELECTOR_INJECTION),
  selectorTimeoutMs: z.number().default(DEFAULT_SELECTOR_TIMEOUT_MS),
  rerankBackend: z.string().default(DEFAULT_RERANK_BACKEND),
  rerankModel: z.string(),
  rerankUrl: z.string(),
  rerankTopN: z.number().default(DEFAULT_RERANK_TOP_N),
});
/**
 * 插件 config 优先于环境变量；只用一份 env 视图解析，不把 key 写回 process.env。
 * 注意用 `incomingConfig` 而不是补过默认值的 `config`：否则默认 none 会盖掉环境变量。
 */
function resolvePluginRerankConfig(incoming = {}) {
  const env = { ...process.env };
  const assign = (key, value) => {
    const text = String(value ?? '').trim();
    if (text) env[key] = text;
  };
  assign('DSH_RECALL_RERANK_BACKEND', incoming.rerankBackend);
  assign('DSH_RECALL_RERANK_MODEL', incoming.rerankModel);
  assign('DSH_RECALL_RERANK_URL', incoming.rerankUrl);
  const topN = Math.floor(Number(incoming.rerankTopN));
  if (Number.isFinite(topN) && topN > 0) env.DSH_RECALL_RERANK_TOP_N = String(topN);
  return resolveRerankConfig(env);
}
function log(message) {
  try {
    console.error(`[dsh-recall] ${message}`);
  } catch { }
}
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function cwdOfSession(session) { const cwd = session?.header?.cwd ?? session?.cwd; return typeof cwd === 'string' && cwd.trim() ? cwd : null; }
function positiveInt(value, fallback) { const n = Math.floor(Number(value)); return Number.isFinite(n) && n > 0 ? n : fallback; }
function sessionQueryOf(ctx) { try { return typeof ctx?.get === 'function' ? (ctx.get('sessionQuery') ?? null) : null; } catch { return null; } }
function withNativeTimeout() { try { return AbortSignal.timeout(NATIVE_TIMEOUT_MS); } catch { return undefined; } }
function collapseText(text) { return String(text ?? '') .replace(/\s+/g, ' ') .trim(); }
function toIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try { return new Date(ms).toISOString(); } catch { return '—'; }
}
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
function userMessageText(message) { return collapseText(blocksText(message?.content)).slice(0, 500); }
function lastUserQuestion(target) {
  const session = target?.session ?? target;
  let events;
  try { events = session?.snapshotEvents?.(); } catch { return ''; }
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
function lastUserMessageText(session) {
  try {
    const nodes = session?.surface?.nodes;
    if (!nodes || typeof session?.eventAt !== 'function') return null;
    const seqs = Array.from(nodes).sort((a, b) => Number(a) - Number(b));
    for (let i = seqs.length - 1; i >= 0; i -= 1) {
      const event = session.eventAt(seqs[i]);
      if (event?.type !== 'user/message') continue;
      if (event.data?.source?.kind === 'runtime-context') continue;
      const text = userMessageText(event.data);
      if (text) return text;
    }
  } catch { }
  return null;
}
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
  } catch { }
  return 0;
}
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
  try { json = JSON.stringify(value ?? null, null, 2); } catch { json = '"（原始事件无法序列化）"'; }
  if (typeof json !== 'string') json = String(json);
  if (json.length > MAX_RAW_JSON_CHARS) {
    return `${json.slice(0, MAX_RAW_JSON_CHARS - 16)}\n…（JSON 已截断）`;
  }
  return json;
}
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
  if (before.length > 0) { lines.push('', 'Before:'); for (const event of before) lines.push(formatNeighborEvent(event)); }
  if (after.length > 0) { lines.push('', 'After:'); for (const event of after) lines.push(formatNeighborEvent(event)); }
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
  if (ancestors.length === 0) { lines.push(trace?.complete === false ? '- [ancestor boundary]' : '- none (root session)'); }
  for (const record of ancestors) {
    lines.push(`- ${record?.header?.id ?? '?'} | ${toIso(record?.header?.createdAt)} | ${availabilityOf(record)}`);
  }
  lines.push('', 'Descendants:');
  if (descendants.length === 0) lines.push('- none');
  else renderTraceDescendants(lines, descendants, 0);
  if (trace?.complete === false) lines.push('', '（血缘不完整：有祖先无法解析）');
  return lines.join('\n');
}
function activeToolNames(ctx, exec) {
  try { const view = ctx?.tools?.view?.(exec?.agent); return view?.visible ? [...view.visible.keys()] : []; } catch { return []; }
}
function formatRecallResult(result) {
  const topics = Array.isArray(result?.topicsUsed) ? result.topicsUsed.length : 0;
  const spans = Array.isArray(result?.spansUsed) ? result.spansUsed.length : 0;
  const skip = result?.skipped ? ` · skipped=${result.skipped}` : '';
  const header = `[memory.recall] topics=${topics} spans=${spans}${skip}`;
  return result?.text ? `${header}\n${result.text}` : `${header}\n（没有足够相关的记忆）`;
}
function formatSpanHit(hit, index) {
  const span = hit?.span ?? {};
  const turns = Array.isArray(span.turns) ? span.turns : [];
  const evidence = Array.isArray(span.evidence) ? span.evidence : [];
  const suffix = turns.length > 0 ? `（第 ${turns.join('、')} 轮）` : '';
  const lines = [`${index}. [${span.type ?? 'span'}] ${collapseText(span.text) || '（空）'}${suffix}`];
  for (const entry of evidence.slice(0, 3)) {
    const sid = entry?.session_id ?? '?';
    const seq = entry?.seq ?? '?';
    const turn = entry?.turn === undefined ? '' : ` turn=${entry.turn}`;
    lines.push(`   证据：session=${sid} seq=${seq}${turn}`);
  }
  const first = evidence.find((entry) => entry?.session_id != null && Number.isFinite(Number(entry?.seq)));
  if (first) {
    lines.push(`→ 下钻：memory(action="read", session_id="${first.session_id}", seq=${Math.trunc(Number(first.seq))})`);
  }
  return lines.join('\n');
}
function formatSpanSearch({ query, scope, hits }) {
  const list = Array.isArray(hits) ? hits : [];
  const lines = [
    `[memory.search] ${list.length} ${list.length === 1 ? 'hit' : 'hits'} · scope=${scope || 'all'}`,
  ];
  if (list.length === 0) { lines.push('（没有匹配的 span；可换关键词，或先用 memory(action="recall", question=...)）'); return lines.join('\n'); }
  for (let i = 0; i < list.length; i += 1) lines.push(formatSpanHit(list[i], i + 1));
  return lines.join('\n');
}
export function apply(ctx, incomingConfig = {}) {
  const config = {
    dbPath: DEFAULT_DB_PATH,
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
    spanEveryTurns: DEFAULT_SPAN_EVERY_TURNS,
    turnsPerBatch: DEFAULT_TURNS_PER_BATCH,
    maxTopics: DEFAULT_MAX_TOPICS,
    threshold: DEFAULT_THRESHOLD,
    lexicalThreshold: DEFAULT_LEXICAL_THRESHOLD,
    maxInjectLines: DEFAULT_MAX_INJECT_LINES,
    selectorInjection: DEFAULT_SELECTOR_INJECTION,
    selectorTimeoutMs: DEFAULT_SELECTOR_TIMEOUT_MS,
    ...incomingConfig,
  };
  const spanEveryTurns = positiveInt(config.spanEveryTurns, DEFAULT_SPAN_EVERY_TURNS);
  const turnsPerBatch = positiveInt(config.turnsPerBatch, DEFAULT_TURNS_PER_BATCH);
  let db;
  try {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    log(`打开数据库失败 ${config.dbPath}: ${errorText(error)}`);
    return;
  }
  const rerankCfg = resolvePluginRerankConfig(incomingConfig);
  if (rerankCfg.backend !== 'none') {
    log(
      `重排 backend=${rerankCfg.backend} model=${rerankCfg.model}`
        + `${rerankCfg.available ? '' : '（不可用，跳过重排）'}`,
    );
  }
  let disposed = false;
  let lastScope = null;
  const timers = new Set();
  const turnCounts = new Map();
  const curatedThroughSeq = new Map();
  const curating = new Set();
  const pendingQuestions = new Map();
  const injectionCache = createInjectionCache({ maxEntries: 128 });
  const later = (fn, delayMs) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try { fn(); } catch (error) {
        log(`定时任务失败: ${errorText(error)}`);
      }
    }, delayMs);
    timers.add(timer);
    return timer;
  };
  const rememberScope = (scope) => { if (typeof scope === 'string' && scope.trim()) lastScope = scope; };
  function resolveScope(agent, promptContext) {
    const session = agent?.session ?? promptContext?.session;
    return cwdOfSession(session)
      ?? agent?.cwd
      ?? promptContext?.cwd
      ?? lastScope
      ?? config.scope
      ?? null;
  }
  function findSessionPath(sessionId) {
    const id = String(sessionId ?? '').trim();
    if (!id) return null;
    try {
      const variants = new Set([id, id.replace(/^session-/, ''), `session-${id}`]);
      const file = listSessionFiles(config.sessionsRoot)
        .find((item) => variants.has(String(item.id)));
      return file?.path ?? null;
    } catch (error) {
      log(`扫描会话目录失败 ${config.sessionsRoot}: ${errorText(error)}`);
      return null;
    }
  }
  function sessionEvents(session) {
    const filePath = findSessionPath(session?.id);
    if (filePath) {
      try {
        const parsed = readSessionFile(filePath);
        if (Array.isArray(parsed?.events) && parsed.events.length > 0) return parsed.events;
      } catch (error) {
        log(`读取会话文件失败 ${filePath}: ${errorText(error)}`);
      }
    }
    try { const snapshot = session?.snapshotEvents?.(); if (Array.isArray(snapshot) && snapshot.length > 0) return snapshot; } catch { }
    return null;
  }
  function readEventFromFile(sessionId, seq) {
    const filePath = findSessionPath(sessionId);
    if (!filePath) {
      return `[memory.read] session=${sessionId} seq=${seq} · 原生不可用，且找不到会话文件（${config.sessionsRoot}）`;
    }
    let events;
    try { events = readSessionFile(filePath).events; } catch (error) {
      return `[memory.read] session=${sessionId} seq=${seq} · 会话文件读取失败：${errorText(error)}`;
    }
    const targetSeq = Math.trunc(Number(seq));
    const targetIndex = events.findIndex((event) => Number(event?.seq) === targetSeq);
    if (targetIndex === -1) {
      const first = events[0]?.seq;
      const last = events[events.length - 1]?.seq;
      return `[memory.read] session=${sessionId} seq=${targetSeq} · 会话文件里没有该 seq（可用范围 ${first}–${last}）`;
    }
    const lines = [
      `[memory.read] session=${sessionId} seq=${targetSeq} · file · raw JSON`,
      '```json',
      formatRawJson(events[targetIndex]),
      '```',
    ];
    const before = targetIndex - 1 >= 0 ? [events[targetIndex - 1]] : [];
    const after = targetIndex + 1 < events.length ? [events[targetIndex + 1]] : [];
    if (before.length > 0) { lines.push('', 'Before:'); for (const event of before) lines.push(formatNeighborEvent(event)); }
    if (after.length > 0) { lines.push('', 'After:'); for (const event of after) lines.push(formatNeighborEvent(event)); }
    return lines.join('\n');
  }
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
    } catch { return null; }
  }
  async function queryVectorFor(query) {
    try {
      const cfg = resolveEmbeddingConfig(process.env);
      if (!cfg.available) return null;
      const vectors = await embedTexts([query], cfg);
      const vector = Array.isArray(vectors) ? vectors[0] : null;
      return vector && vector.length > 0 ? vector : null;
    } catch (error) {
      log(`问题向量化失败，退回词法检索: ${errorText(error)}`);
      return null;
    }
  }
  async function recallMemory({ scope, question, activeTools }) {
    const base = { db, scope, question, maxTopics: config.maxTopics, threshold: config.lexicalThreshold, maxLines: config.maxInjectLines, rerankCfg, };
    const timeoutMs = 20_000;
    const injection = await resolveInjection({ ...base, activeTools, complete: llmComplete(timeoutMs), timeoutMs, });
    if (injection.text) return formatRecallResult(injection);
    const fallback = buildInjectionSync(base);
    if (fallback.text) { return formatRecallResult({ ...fallback, skipped: injection.skipped ?? 'no-selector' }); }
    return formatRecallResult(injection);
  }
  async function buildSelectorInjection(agent, session, scope) {
    const question = currentQuestion(agent, { session });
    if (!question) return '';
    const timeoutMs = positiveInt(config.selectorTimeoutMs, DEFAULT_SELECTOR_TIMEOUT_MS);
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
      rerankCfg,
    });
    return result?.text || '';
  }
  function currentQuestion(agent, promptContext) {
    try {
      const session = agent?.session ?? promptContext?.session;
      const sessionId = session?.id;
      if (sessionId) { const cached = pendingQuestions.get(sessionId); if (cached && Date.now() - cached.at <= QUESTION_TTL_MS) return cached.text; }
      return lastUserMessageText(session) || lastUserQuestion(agent) || '';
    } catch { return ''; }
  }
  async function runCuration(session, scope) {
    const sessionId = session?.id;
    if (disposed || !sessionId || curating.has(sessionId)) return;
    const complete = llmComplete(CURATION_TIMEOUT_MS);
    if (!complete) return; // 没凭据：不整理，也不刷日志
    const allEvents = sessionEvents(session);
    if (!Array.isArray(allEvents) || allEvents.length === 0) {
      log(`整理跳过 session=${sessionId}：拿不到会话事件`);
      return;
    }
    const lastSeq = curatedThroughSeq.get(sessionId) ?? -1;
    const hasSeq = allEvents.some((event) => Number.isFinite(Number(event?.seq)));
    const windowEvents = hasSeq
      ? allEvents.filter((event) => Number(event.seq) > lastSeq)
      : allEvents;
    if (windowEvents.length === 0) return;
    const maxSeq = hasSeq
      ? allEvents.reduce((max, event) => Math.max(max, Number(event.seq)), lastSeq)
      : null;
    curating.add(sessionId);
    try {
      const embedCfg = resolveEmbeddingConfig(process.env);
      const stats = await curateSession(db, {
        sessionId,
        scope,
        turnsPerBatch,
        complete,
        embed: embedCfg.available ? embedCfg : undefined,
        events: windowEvents,
        ...(typeof config.topicDir === 'string' && config.topicDir.trim() ? { topicDir: config.topicDir } : {}),
      });
      if (!disposed && maxSeq !== null && maxSeq > lastSeq) { curatedThroughSeq.set(sessionId, maxSeq); }
      const failed = stats.failures > 0 ? ` · 失败批次 ${stats.failures}` : '';
      log(
        `后台整理 session=${sessionId} · turns ${stats.turns} · span ${stats.inserted}` +
          ` · topic ${stats.topics}${failed}`,
      );
    } catch (error) {
      log(`后台整理失败 session=${sessionId}: ${errorText(error)}`);
    } finally { curating.delete(sessionId); }
  }
  try {
    ctx.tools.register(
      defineTool({
        name: MEMORY_TOOL_NAME,
        description: MEMORY_TOOL_DESCRIPTION,
        parameters: MEMORY_TOOL_PARAMETERS,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }], },
        execute: async (args = {}, exec) => {
          const cwd = exec?.agent?.session?.header?.cwd;
          rememberScope(cwd);
          const scope = String(args.scope ?? cwd ?? config.scope ?? 'global').trim() || 'global';
          try {
            const sessionQuery = sessionQueryOf(ctx);
            switch (args.action) {
              case 'search': {
                const query = String(args.query ?? '').trim();
                if (!query) return '[memory.error] search: 需要 query';
                const limit = positiveInt(args.limit, 8);
                const queryVec = await queryVectorFor(query);
                const hits = await retrieveSpans(db, {
                  query,
                  scope: scope === 'global' ? undefined : scope,
                  limit,
                  threshold: 0,
                  queryVec,
                  rerankCfg,
                });
                return formatSpanSearch({ query, scope, hits });
              }
              case 'recall': {
                const question = String(args.question ?? args.query ?? '').trim();
                if (!question) return '[memory.error] recall: 需要 question';
                return await recallMemory({ scope, question, activeTools: activeToolNames(ctx, exec), });
              }
              case 'read': {
                const sessionId = String(args.session_id ?? args.sessionId ?? '').trim();
                const seq = Math.trunc(Number(args.seq));
                if (!sessionId) return '[memory.error] read: 需要 session_id';
                if (!Number.isFinite(seq)) return '[memory.error] read: 需要 seq';
                if (sessionQuery && typeof sessionQuery.readEvent === 'function') {
                  try {
                    const window = await sessionQuery.readEvent( { sessionId, seq, before: 1, after: 1 }, withNativeTimeout(), );
                    if (window?.target) return formatNativeEventRead(window, sessionId, seq);
                  } catch (error) {
                    log(`原生 readEvent 失败，回退会话文件: ${errorText(error)}`);
                  }
                }
                return readEventFromFile(sessionId, seq);
              }
              case 'trace': {
                const sessionId = String( args.session_id ?? args.sessionId ?? exec?.agent?.session?.id ?? '', ).trim();
                if (!sessionId) return '[memory.trace] 需要 session_id（当前会话没有 id）';
                if (!sessionQuery || typeof sessionQuery.traceSession !== 'function') { return '[memory.trace] 原生 session-query 不可用'; }
                try {
                  const trace = await sessionQuery.traceSession(sessionId, withNativeTimeout());
                  if (trace) return formatNativeSessionTrace(trace, sessionId);
                  return '[memory.trace] 原生 session-query 没有返回血缘';
                } catch (error) {
                  log(`原生 traceSession 失败: ${errorText(error)}`);
                  return '[memory.trace] 原生 traceSession 调用失败（可稍后重试）';
                }
              }
              default:
                return `[memory] 未知 action: ${String(args.action)}；可用：search / recall / read / trace`;
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
    try { db.close(); } catch { }
    return;
  }
  try {
    ctx.systemPrompt.context({
      name: 'dsh-recall',
      order: 900,
      interpolate: false,
      text: (promptContext) => {
        if (disposed) return '';
        if (config.selectorInjection) return MEMORY_INSTRUCTION;
        const agent = promptContext?.agent ?? promptContext?.scope;
        const scope = resolveScope(agent, promptContext);
        if (!scope) return MEMORY_INSTRUCTION;
        try {
          const question = currentQuestion(agent, promptContext);
          if (!question) return MEMORY_INSTRUCTION;
          const injection = buildInjectionSync({
            db,
            scope,
            question,
            maxTopics: config.maxTopics,
            threshold: config.lexicalThreshold,
            maxLines: config.maxInjectLines,
          }).text;
          return injection ? `${MEMORY_INSTRUCTION}\n\n${injection}` : MEMORY_INSTRUCTION;
        } catch (error) {
          log(`构建常驻注入失败: ${errorText(error)}`);
          return MEMORY_INSTRUCTION;
        }
      },
    });
  } catch (error) {
    log(`注册常驻指令失败: ${errorText(error)}`);
  }
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
          const scope = resolveScope(agent, context);
          if (!scope) return assembly;
          const text = await buildSelectorInjection(agent, session, scope);
          if (!text) return assembly;
          const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : [];
          return { ...assembly, contexts: [ ...contexts, { name: 'dsh-recall:injection', text, interpolate: false }, ], };
        } catch (error) {
          log(`异步注入失败（不影响组装）: ${errorText(error)}`);
          return assembly;
        }
      }, { prepend: true });
    } catch (error) {
      log(`注册异步注入失败: ${errorText(error)}`);
    }
  }
  try {
    ctx.on('session/event', (session, event) => {
      try {
        rememberScope(cwdOfSession(session));
        const id = session?.id ?? event?.session_id ?? 'unknown';
        if (event?.type !== 'turn/end') return;
        pendingQuestions.delete(id);
        injectionCache.deleteByPrefix(`${id}:`);
        const count = (turnCounts.get(id) ?? 0) + 1;
        if (count < spanEveryTurns) { turnCounts.set(id, count); return; }
        turnCounts.set(id, 0);
        const scope = cwdOfSession(session) ?? lastScope ?? config.scope ?? null;
        if (!scope) return;
        later(() => { void runCuration(session, scope); }, 1_000);
      } catch (error) {
        log(`处理 session/event 失败: ${errorText(error)}`);
      }
    });
  } catch (error) {
    log(`监听 session/event 失败: ${errorText(error)}`);
  }
  try {
    ctx.on('agent/inbox/claimed', (subject, payload) => {
      try {
        const agent = payload?.agent ?? subject?.agent ?? subject;
        const sessionId = agent?.session?.id ?? agent?.id;
        if (!sessionId) return;
        if (payload?.message?.source?.kind !== 'user') return;
        const text = userMessageText(payload?.message);
        if (!text) return;
        pendingQuestions.set(sessionId, { text, at: Date.now() });
        injectionCache.deleteByPrefix(`${sessionId}:`);
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
  ctx.effect(() => () => {
    disposed = true;
    pendingQuestions.clear();
    injectionCache.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    turnCounts.clear();
    curatedThroughSeq.clear();
    curating.clear();
    try { db.close(); } catch (error) {
      log(`关闭数据库失败: ${errorText(error)}`);
    }
  });
}
