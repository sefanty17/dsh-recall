// Cordis 插件：把 core 包装成 DSH 的 memory 工具 + 常驻指令 + 每轮注入 + 后台整理。
// 本文件依赖 @deepseek-ai/*，只能在 DSH 里跑；本地用 node --check 验语法。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { openDb } from '../core/db.js';
import { listSessionFiles, readSessionFile } from '../core/reader.js';
import { searchSpans } from '../core/spans.js';
import { curateSession } from '../core/curator.js';
import { chatJson, resolveLlmConfig } from '../core/llm.js';
import { embedTexts, resolveEmbeddingConfig } from '../core/vectors.js';
import {
  MEMORY_INSTRUCTION,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_PARAMETERS,
} from './tool-spec.js';
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
const DEFAULT_SPAN_EVERY_TURNS = 5;
const DEFAULT_TURNS_PER_BATCH = 5;
const DEFAULT_MAX_TOPICS = 8;
const DEFAULT_THRESHOLD = 0.58;
const DEFAULT_LEXICAL_THRESHOLD = 0.55;
const DEFAULT_MAX_INJECT_LINES = 200;
/** 默认开启选择器注入（system-prompt/assemble async waterfall）。 */
const DEFAULT_SELECTOR_INJECTION = true;
/** 原生 session-query 调用的超时；超时/报错都静默回退本地。 */
const NATIVE_TIMEOUT_MS = 3_000;
/** 后台整理单次模型调用超时；整理是低频任务，给足时间。 */
const CURATION_TIMEOUT_MS = 60_000;
/** 原生 read 返回的原始 JSON 上限，防止一个巨大 tool result 撑爆上下文。 */
const MAX_RAW_JSON_CHARS = 12_000;
/** 当前问题缓存的有效期；超过说明这个 turn 早已结束，不再用它注入。 */
const QUESTION_TTL_MS = 30 * 60_000;

export const Config = z.object({
  dbPath: z.string().default(DEFAULT_DB_PATH),
  sessionsRoot: z.string().default(DEFAULT_SESSIONS_ROOT),
  // 可选：拿不到 agent cwd 时的兜底 scope
  scope: z.string(),
  // 每多少轮触发一次后台整理
  spanEveryTurns: z.number().default(DEFAULT_SPAN_EVERY_TURNS),
  // 每次送给 curator 的轮数
  turnsPerBatch: z.number().default(DEFAULT_TURNS_PER_BATCH),
  // 主题 md 输出目录；不填时用 topics.js 的默认值 / DSH_RECALL_TOPIC_DIR
  topicDir: z.string(),
  // 主题召回阈值 / 数量 / 行数上限
  maxTopics: z.number().default(DEFAULT_MAX_TOPICS),
  threshold: z.number().default(DEFAULT_THRESHOLD),
  lexicalThreshold: z.number().default(DEFAULT_LEXICAL_THRESHOLD),
  maxInjectLines: z.number().default(DEFAULT_MAX_INJECT_LINES),
  // true：每轮在 system-prompt/assemble 里跑选择器（超时退回同步）；
  // false：只在常驻 context 里做词法注入。
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

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// 原生 session-query：可选服务 + 文本格式化
// 服务名、方法名与请求形状以 @deepseek-ai/dsh-session-query（及 -sqlite）为准：
//   readEvent({ sessionId, seq, before?, after? }, signal)
//   traceSession(sessionId, signal)
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
  if (list.length === 0) {
    lines.push('（没有匹配的 span；可换关键词，或先用 memory(action="recall", question=...)）');
    return lines.join('\n');
  }
  for (let i = 0; i < list.length; i += 1) lines.push(formatSpanHit(list[i], i + 1));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

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

  // (a) 打开数据库
  let db;
  try {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
    // 后台整理与工具读取可能并发；等锁而不是立刻失败。
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    log(`打开数据库失败 ${config.dbPath}: ${errorText(error)}`);
    return;
  }

  let disposed = false;
  let lastScope = null;
  const timers = new Set();
  // session id -> 本整理周期内的 turn/end 次数
  const turnCounts = new Map();
  // session id -> 已整理到的最大 seq（避免每次重跑整段会话、重复插 span）
  const curatedThroughSeq = new Map();
  // 同一会话的整理串行执行
  const curating = new Set();
  // session id -> { text, at }：agent/inbox/claimed 在 preStep 组装提示词之前触发，
  // 是拿到「本轮问题」的唯一可靠时机（step 里才把 user/message 写进 session）。
  const pendingQuestions = new Map();
  // `${sessionId}:${turn}` -> 注入结果；同一 turn 的多次 assemble 只跑一次选择器。
  const injectionCache = createInjectionCache({ maxEntries: 128 });

  const later = (fn, delayMs) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
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

  function resolveScope(agent, promptContext) {
    const session = agent?.session ?? promptContext?.session;
    return cwdOfSession(session)
      ?? agent?.cwd
      ?? promptContext?.cwd
      ?? lastScope
      ?? config.scope
      ?? null;
  }

  /** 会话文件路径：按 session id 在 sessionsRoot 里找，兼容带不带 session- 前缀。 */
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

  /** 整理用的原始事件：优先会话文件（完整、含 reasoning），否则用当前 session 日志。 */
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
    try {
      const snapshot = session?.snapshotEvents?.();
      if (Array.isArray(snapshot) && snapshot.length > 0) return snapshot;
    } catch {
      // ignore
    }
    return null;
  }

  /** read 的本地兜底：readSessionFile + 按 seq 找事件，返回原始 JSON。 */
  function readEventFromFile(sessionId, seq) {
    const filePath = findSessionPath(sessionId);
    if (!filePath) {
      return `[memory.read] session=${sessionId} seq=${seq} · 原生不可用，且找不到会话文件（${config.sessionsRoot}）`;
    }
    let events;
    try {
      events = readSessionFile(filePath).events;
    } catch (error) {
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

  /** 有可用 embedding 时把问题转成向量，search 走混合召回；失败静默退回词法。 */
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

  /**
   * system-prompt/assemble 的异步注入：每 turn 跑一次选择器（结果缓存），
   * 超时/报错退回同步词法；返回最终文本（可能为空串）。
   */
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
    });
    return result?.text || '';
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

  // (b) 后台整理：每 spanEveryTurns 个 turn/end 整理一次；同一会话不并发。
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
        ...(typeof config.topicDir === 'string' && config.topicDir.trim()
          ? { topicDir: config.topicDir }
          : {}),
      });
      if (!disposed && maxSeq !== null && maxSeq > lastSeq) {
        curatedThroughSeq.set(sessionId, maxSeq);
      }
      const failed = stats.failures > 0 ? ` · 失败批次 ${stats.failures}` : '';
      log(
        `后台整理 session=${sessionId} · turns ${stats.turns} · span ${stats.inserted}` +
          ` · topic ${stats.topics}${failed}`,
      );
    } catch (error) {
      log(`后台整理失败 session=${sessionId}: ${errorText(error)}`);
    } finally {
      curating.delete(sessionId);
    }
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
          const scope = String(args.scope ?? cwd ?? config.scope ?? 'global').trim() || 'global';
          try {
            const sessionQuery = sessionQueryOf(ctx);
            switch (args.action) {
              case 'search': {
                const query = String(args.query ?? '').trim();
                if (!query) return '[memory.error] search: 需要 query';
                const limit = positiveInt(args.limit, 8);
                const queryVec = await queryVectorFor(query);
                const hits = searchSpans(db, {
                  query,
                  scope: scope === 'global' ? undefined : scope,
                  limit,
                  queryVec,
                });
                return formatSpanSearch({ query, scope, hits });
              }
              case 'recall': {
                const question = String(args.question ?? args.query ?? '').trim();
                if (!question) return '[memory.error] recall: 需要 question';
                return await recallMemory({
                  scope,
                  question,
                  activeTools: activeToolNames(ctx, exec),
                });
              }
              case 'read': {
                const sessionId = String(args.session_id ?? args.sessionId ?? '').trim();
                const seq = Math.trunc(Number(args.seq));
                if (!sessionId) return '[memory.error] read: 需要 session_id';
                if (!Number.isFinite(seq)) return '[memory.error] read: 需要 seq';
                if (sessionQuery && typeof sessionQuery.readEvent === 'function') {
                  try {
                    const window = await sessionQuery.readEvent(
                      { sessionId, seq, before: 1, after: 1 },
                      withNativeTimeout(),
                    );
                    if (window?.target) return formatNativeEventRead(window, sessionId, seq);
                  } catch (error) {
                    log(`原生 readEvent 失败，回退会话文件: ${errorText(error)}`);
                  }
                }
                return readEventFromFile(sessionId, seq);
              }
              case 'trace': {
                const sessionId = String(
                  args.session_id ?? args.sessionId ?? exec?.agent?.session?.id ?? '',
                ).trim();
                if (!sessionId) return '[memory.trace] 需要 session_id（当前会话没有 id）';
                if (!sessionQuery || typeof sessionQuery.traceSession !== 'function') {
                  return '[memory.trace] 原生 session-query 不可用';
                }
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
    try {
      db.close();
    } catch {
      // ignore
    }
    return;
  }

  // (d) 常驻指令：静态一段，替代 v1 状态表。
  // selectorInjection=false 时，把同步词法注入附在指令后面（否则没有任何每轮注入）。
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
          const scope = resolveScope(agent, context);
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

  // (f) 会话事件：数 turn/end；到阈值就排一次后台整理。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        rememberScope(cwdOfSession(session));
        const id = session?.id ?? event?.session_id ?? 'unknown';
        if (event?.type !== 'turn/end') return;
        // 本轮结束：清掉「本轮问题」和注入缓存，避免下一轮复用旧结果。
        pendingQuestions.delete(id);
        injectionCache.deleteByPrefix(`${id}:`);
        const count = (turnCounts.get(id) ?? 0) + 1;
        if (count < spanEveryTurns) {
          turnCounts.set(id, count);
          return;
        }
        turnCounts.set(id, 0);
        const scope = cwdOfSession(session) ?? lastScope ?? config.scope ?? null;
        if (!scope) return;
        later(() => {
          void runCuration(session, scope);
        }, 1_000);
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

  // (h) 卸载时清理定时器与缓存（不再有 worker）
  ctx.effect(() => () => {
    disposed = true;
    pendingQuestions.clear();
    injectionCache.clear();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    turnCounts.clear();
    curatedThroughSeq.clear();
    curating.clear();
    try {
      db.close();
    } catch (error) {
      log(`关闭数据库失败: ${errorText(error)}`);
    }
  });
}
