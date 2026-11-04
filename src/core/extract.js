/**
 * src/core/extract.js
 *
 * L2：用宿主模型（OpenAI 兼容接口）从会话的用户消息里抽事实。
 *
 * 接口：
 *   buildExtractionMessages({ header, messages })       -> [{role, content}]
 *   parseFacts(raw, { header, messages })               -> { facts, rejected }
 *   extractSessionFacts(db, { header, messages }, opts) -> { inserted, updated, rejected }
 *   extractAll(db, sessionsRoot, opts)
 *
 * 输入纪律（与 ingest.js 的规则抽取一致，但更严格）：
 *   - 只取 user/message 且 data.source.kind === 'user' 的消息
 *   - 跳过 header.delegationDepth > 0 或 origin === 'subagent' 的会话
 *
 * 质量闸门（parseFacts）：
 *   - seq 必须存在于送给模型的输入消息里
 *   - quote 必须是该条消息文本的逐字子串（indexOf），否则丢弃
 *   - kind 不在枚举里 -> fact；key 不在词表里 -> note；value 不符合标识符 -> null
 *
 * 原文只读：这里只读会话文件，写入的只有派生 facts 和幂等标记。
 */

import { listSessionFiles, readSessionFile } from './reader.js';
import { upsertFact } from './facts.js';
import { redactSecrets } from './llm.js';

/** kind 枚举（design.md 的 facts.kind 子集，不含 todo） */
export const FACT_KINDS = ['decision', 'preference', 'constraint', 'failure', 'fact'];

/** key 词表：优先用这套；不在这套里的归为 note */
export const FACT_KEYS = [
  'pkg-manager',
  'test-command',
  'build-command',
  'deploy',
  'branch-policy',
  'port',
  'never-use',
  'note',
];

/** value 必须是短标识符 */
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._@/:\-]{0,39}$/;

/** 命令类 key 的 value 允许单个空格（cargo test / go build ./...），与 rules.js 保持一致 */
const COMMAND_KEYS = new Set(['test-command', 'build-command', 'deploy']);
const COMMAND_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._@/:\- ]{0,59}$/;

function isCommandValue(value) {
  return typeof value === 'string'
    && COMMAND_VALUE_RE.test(value)
    && !value.endsWith(' ')
    && !value.includes('  ');
}

/** 模型自造 key：短英文 slug（小写字母开头，2–24 字符） */
const CUSTOM_KEY_RE = /^[a-z][a-z0-9-]{1,23}$/;
/** 自造 key 的 value 上限（中文短语按字符数，最多 24 字） */
const CUSTOM_VALUE_MAX_CHARS = 24;
/** 标点结尾（含中英文标点）；自造 key 的 value 不允许 */
const TRAILING_PUNCT_RE = /\p{P}$/u;

/** 自造 key 的 value：短中文短语；非法返回 null（调用方回退 note） */
function normalizeCustomValue(rawValue) {
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return null;
  const text = String(rawValue).trim();
  if (text === '') return null;
  if (/[\r\n]/.test(text)) return null;
  if (Array.from(text).length > CUSTOM_VALUE_MAX_CHARS) return null;
  if (TRAILING_PUNCT_RE.test(text)) return null;
  return text;
}

/** 单条消息送进 prompt 的最大字符数 */
const MAX_MESSAGE_CHARS = 2000;
/** 一次 prompt 的总字符预算 */
const MAX_TOTAL_CHARS = 28_000;
/** 超预算时，前段 / 后段各自保留的预算（后段更重要：更接近当前状态） */
const PREFIX_BUDGET = 9000;
const SUFFIX_BUDGET = 17_000;
/** note 最大长度 */
const MAX_NOTE_CHARS = 240;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 把各种时间表示统一成毫秒整数；非法值返回 null */
function toEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.round(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function seqOf(event, index) {
  const n = Number(event?.seq);
  return Number.isFinite(n) ? Math.trunc(n) : index + 1;
}

function formatTime(value) {
  const epoch = toEpoch(value);
  if (epoch === null) return '?';
  try {
    return new Date(epoch).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '?';
  }
}

function sessionIdOf(header) {
  const raw = header?.id ?? header?.sessionId ?? header?.session_id;
  return typeof raw === 'string' ? raw.trim() : '';
}

function scopeOf(header) {
  if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd;
  if (typeof header?.workdir === 'string' && header.workdir !== '') return header.workdir;
  return 'global';
}

/** 子代理会话会重放父会话的上下文，不参与 L2 抽取 */
export function isSubagentSession(header) {
  const depth = Number(header?.delegationDepth ?? 0);
  return (Number.isFinite(depth) && depth > 0) || header?.origin === 'subagent';
}

// ---------------------------------------------------------------------------
// 输入选择
// ---------------------------------------------------------------------------

/** 从 user/message 事件里取纯文本（跳过 reasoning / 图片 / 附件块） */
function userMessageText(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const parts = [];

  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (value !== '') parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object') return;

    const type = typeof value.type === 'string' ? value.type : '';
    if (type === 'reasoning' || type === 'thinking' || type === 'redacted_thinking') return;
    if (type === 'text') {
      if (typeof value.text === 'string' && value.text !== '') parts.push(value.text);
      return;
    }
    if (type === 'image' || type === 'file' || type === 'tool-call' || type === 'tool-result') {
      return;
    }
    if (typeof value.text === 'string' && value.text !== '') parts.push(value.text);
  };

  walk(data.content);
  if (parts.length === 0 && typeof data.text === 'string' && data.text !== '') {
    parts.push(data.text);
  }
  return parts.join('\n').trim();
}

/**
 * 从事件流里挑出真正由用户说的话。
 * 严格只保留 data.source.kind === 'user'（plugin / agent-instructions / agent-message 等一律跳过）。
 * @param {object[]} events
 * @returns {Array<{seq: number, time: number|null, text: string}>}
 */
export function selectUserMessages(events) {
  const list = Array.isArray(events) ? events : [];
  const messages = [];
  list.forEach((event, index) => {
    if (event?.type !== 'user/message') return;
    if (event?.data?.source?.kind !== 'user') return;
    const text = userMessageText(event);
    if (text === '') return;
    messages.push({
      seq: seqOf(event, index),
      time: toEpoch(event?.time ?? event?.timestamp ?? event?.at),
      text,
    });
  });
  return messages;
}

function isEventList(list) {
  return list.some((item) => item && typeof item === 'object'
    && (item.data !== undefined || item.type === 'user/message' || item.type === 'assistant/message'));
}

function normalizePlainMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  list.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (text === '') return;
    out.push({
      seq: seqOf(message, index),
      time: toEpoch(message.time ?? message.since),
      text,
    });
  });
  return out;
}

function clipText(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit);
}

/**
 * 控制 prompt 体积：单条截断 + 总预算。
 * 超预算时保留前段（项目早期的约定）和后段（最近的状态），中间省略。
 * 返回值就是 parseFacts 的校验范围——模型没看到的文本不可能有合法引文。
 */
function fitMessages(messages) {
  const clipped = messages.map((message) => ({
    ...message,
    text: clipText(message.text, MAX_MESSAGE_CHARS),
  }));
  const total = clipped.reduce((sum, message) => sum + message.text.length, 0);
  if (total <= MAX_TOTAL_CHARS) return clipped;

  const head = [];
  let headChars = 0;
  for (const message of clipped) {
    if (headChars + message.text.length > PREFIX_BUDGET) break;
    head.push(message);
    headChars += message.text.length;
  }

  const tail = [];
  let tailChars = 0;
  for (let i = clipped.length - 1; i >= 0; i -= 1) {
    const message = clipped[i];
    if (tailChars + message.text.length > SUFFIX_BUDGET) break;
    tail.push(message);
    tailChars += message.text.length;
  }
  tail.reverse();

  const headSeqs = new Set(head.map((message) => message.seq));
  const kept = head.concat(tail.filter((message) => !headSeqs.has(message.seq)));
  kept.sort((a, b) => a.seq - b.seq);
  return kept;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是「项目记忆抽取器」：从编号的用户消息里，抽取跨会话仍然有效的项目约定，只输出 JSON。

只记录：decision（已定的技术选择）、preference（用户偏好）、constraint（必须遵守/禁止的做法）、failure（踩过的坑）、fact（稳定事实）。
不要记录：纯临时状态、代码或配置里本来就能看到的东西、寒暄、提问。
判断标准：三个月后另一个会话还需要知道吗？长期有效的给稳定 key；只是这次任务要用的给 note。

规则：
- kind 只能是 decision|preference|constraint|failure|fact。
- 词表（首选）：pkg-manager（包管理器）、test-command（测试命令）、build-command（构建命令）、deploy（部署）、branch-policy（分支策略）、port（端口）、never-use（禁止使用）、note（其他/临时）。
- 如果一个决定会长期约束后续工作，给它一个稳定的 key；如果只是这次任务的临时要求，用 note。
- 词表装不下时，自造短英文 slug：小写字母开头，只含 a-z、0-9、-，2–24 个字符，如 ui-style、doc-policy、llm-config、reply-tone。
- 词表 key 的 value 用短标识符（包名/命令/端口/单词，抽不出给 null）；自造 key 的 value 用简短中文短语（≤24 字，不含换行，不以标点结尾）。
- test-command / build-command / deploy 的 value 可以是一条命令（如 "cargo test"、"go build ./..."），只允许单个空格，不能有连续空格或结尾空格。
- quote 必须是某条消息里逐字出现的片段：不改写、不翻译、不拼接；seq 是该消息的编号。
- 没有值得记的就返回 {"facts":[]}。宁可空，不要编。

只输出 JSON，不要解释：
{"facts":[{"key":"pkg-manager","value":"pnpm","kind":"preference","quote":"以后统一用 pnpm","seq":12,"note":"可空"},{"key":"ui-style","value":"暖色调为主","kind":"preference","quote":"主体的那个配色尽量改成暖色调为主","seq":13,"note":"可空"}]}`;

/**
 * 构造抽取 prompt。
 * @param {{ header?: object, messages?: Array<{seq: number, time?: number|null, text: string}> }} input
 * @returns {Array<{role: 'system'|'user', content: string}>}
 */
export function buildExtractionMessages(input = {}) {
  const header = input?.header && typeof input.header === 'object' ? input.header : {};
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const cwd = scopeOf(header);
  const startedAt = toEpoch(header.createdAt ?? header.created_at ?? header.time)
    ?? (messages.length > 0 ? messages[0].time : null);

  const lines = messages.map((message) => (
    `[${message.seq}] ${formatTime(message.time)} · ${message.text}`
  ));
  const user = [
    `项目：${cwd}`,
    `会话：${sessionIdOf(header) || 'unknown'} · 开始于 ${formatTime(startedAt)}`,
    '',
    '用户消息（格式：[seq] 时间 · 文本）：',
    ...(lines.length > 0 ? lines : ['（没有用户消息）']),
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function stripJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) return trimmed.slice(3).replace(/```\s*$/, '').trim();
  return trimmed.slice(firstBreak + 1).replace(/```\s*$/, '').trim();
}

function parseRawJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') {
    throw new TypeError('parseFacts: raw 必须是对象或 JSON 字符串');
  }
  const candidates = [raw.trim()];
  const fenced = stripJsonFence(raw);
  if (fenced !== candidates[0]) candidates.push(fenced);
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(raw.slice(open, close + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 试下一种
    }
  }
  throw new Error('parseFacts: 模型返回无法解析为 JSON');
}

/**
 * 校验并归一化模型返回。坏引文/坏 seq 直接丢弃，其余字段尽量归一。
 * @param {object|string} raw 已解析对象或 JSON 文本（可带 ```json 围栏）
 * @param {{ header?: object, messages?: Array<{seq: number, text: string}> }} input
 * @returns {{ facts: object[], rejected: Array<{reason: string, fact: any}> }}
 */
export function parseFacts(raw, input = {}) {
  void input?.header;
  const parsed = parseRawJson(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.facts;
  if (!Array.isArray(list)) {
    return { facts: [], rejected: [{ reason: 'facts_not_array', fact: parsed }] };
  }

  const bySeq = new Map();
  for (const message of Array.isArray(input?.messages) ? input.messages : []) {
    const seq = Number(message?.seq);
    if (!Number.isFinite(seq)) continue;
    const key = Math.trunc(seq);
    if (!bySeq.has(key)) bySeq.set(key, message);
  }

  const facts = [];
  const rejected = [];
  const seen = new Set();

  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected.push({ reason: 'invalid_fact', fact: item });
      continue;
    }

    const rawSeq = Number(item.seq);
    const seq = Number.isFinite(rawSeq) ? Math.trunc(rawSeq) : NaN;
    const message = Number.isFinite(seq) ? bySeq.get(seq) : undefined;
    if (!message) {
      rejected.push({ reason: 'seq_not_found', fact: item });
      continue;
    }

    const quote = typeof item.quote === 'string' ? item.quote : '';
    if (quote === '' || !message.text.includes(quote)) {
      rejected.push({ reason: 'quote_not_found', fact: item });
      continue;
    }

    const kind = FACT_KINDS.includes(item.kind) ? item.kind : 'fact';

    const rawKey = typeof item.key === 'string' ? item.key.trim() : '';
    let key;
    let value = null;

    if (FACT_KEYS.includes(rawKey)) {
      // 词表 key：保持原有取值规则
      key = rawKey;
      if (typeof item.value === 'string' || typeof item.value === 'number') {
        const candidate = String(item.value).trim();
        if (VALUE_RE.test(candidate)) value = candidate;
        else if (COMMAND_KEYS.has(key) && isCommandValue(candidate)) value = candidate;
      }
    } else if (CUSTOM_KEY_RE.test(rawKey)) {
      // 模型自造 key：value 允许短中文短语；value 不合法时整条回退成 note
      const customValue = normalizeCustomValue(item.value);
      if (customValue === null) {
        key = 'note';
      } else {
        key = rawKey;
        value = customValue;
      }
    } else {
      // key 既不在词表也不是合法 slug：回退 note，value 丢弃
      key = 'note';
    }

    const note = typeof item.note === 'string' && item.note.trim() !== ''
      ? item.note.trim().slice(0, MAX_NOTE_CHARS)
      : null;

    const dedupeKey = `${seq}\u0000${key}\u0000${value ?? ''}\u0000${quote}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const spanStart = message.text.indexOf(quote);
    facts.push({
      key,
      value,
      kind,
      quote,
      seq,
      since: message.time ?? null,
      span_start: spanStart,
      span_end: spanStart + quote.length - 1,
      note,
    });
  }

  return { facts, rejected };
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

function ensureSessionRow(db, header, sessionId, scope) {
  const createdAt = toEpoch(header?.createdAt ?? header?.created_at ?? header?.time);
  const parentId = header?.parentId ?? header?.parent_id ?? null;
  db.prepare(`
    INSERT INTO sessions (id, path, cwd, created_at, parent_id, origin, event_count, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
    ON CONFLICT(id) DO UPDATE SET
      path = COALESCE(sessions.path, excluded.path),
      cwd = COALESCE(sessions.cwd, excluded.cwd),
      created_at = COALESCE(sessions.created_at, excluded.created_at)
  `).run(
    sessionId,
    typeof header?.path === 'string' ? header.path : null,
    scope,
    createdAt,
    typeof parentId === 'string' ? parentId : null,
    typeof header?.origin === 'string' ? header.origin : null,
  );
}

function isSessionExtracted(db, sessionId) {
  const row = db.prepare('SELECT llm_extracted_at FROM sessions WHERE id = ?').get(sessionId);
  return Boolean(row && row.llm_extracted_at !== null && row.llm_extracted_at !== undefined);
}

function markSessionExtracted(db, sessionId) {
  db.prepare('UPDATE sessions SET llm_extracted_at = ? WHERE id = ?').run(Date.now(), sessionId);
}

/** 与 facts.upsertFact 保持一致：note / value=null 按 quote 区分，约束按 value 去重 */
function isQuoteScopedFact(fact) {
  return fact.key === 'note' || fact.value === null || fact.value === undefined;
}

function isMultiValueFact(fact) {
  return fact.kind === 'constraint' || fact.key === 'never-use' || isQuoteScopedFact(fact);
}

/** 当前仍 active、会被这次写入命中的事实（用于区分 inserted / updated） */
function activeFactFor(db, scope, fact) {
  if (isQuoteScopedFact(fact)) {
    return db.prepare(`
      SELECT id, value FROM facts
      WHERE key = ? AND scope = ? AND value IS ? AND quote IS ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(fact.key, scope, fact.value ?? null, fact.quote ?? null) || null;
  }
  if (isMultiValueFact(fact)) {
    return db.prepare(`
      SELECT id, value FROM facts
      WHERE key = ? AND scope = ? AND value IS ? AND status = 'active'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(fact.key, scope, fact.value ?? null) || null;
  }
  return db.prepare(`
    SELECT id, value FROM facts
    WHERE key = ? AND scope = ? AND status = 'active'
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(fact.key, scope) || null;
}

/**
 * 处理一个会话：选输入 -> 调模型 -> 校验 -> upsert -> 写幂等标记。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ header: object, messages: object[] }} session
 *        messages 可以是事件流，也可以是已挑好的 {seq,time,text}
 * @param {{
 *   complete: (messages: Array<{role:string, content:string}>) => Promise<object|string>,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   onFact?: (fact: object, phase: string) => void,
 * }} options
 * @returns {Promise<{inserted:number, updated:number, rejected:number}>}
 */
export async function extractSessionFacts(db, session, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('extractSessionFacts: 需要一个 SQLite 数据库实例');
  }
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new TypeError('extractSessionFacts: 需要 complete 函数');
  }

  const header = session?.header && typeof session.header === 'object' ? session.header : {};
  const empty = { inserted: 0, updated: 0, rejected: 0 };

  if (isSubagentSession(header)) return { ...empty };
  const sessionId = sessionIdOf(header);
  if (!sessionId) throw new Error('extractSessionFacts: header.id 缺失');

  const rawMessages = Array.isArray(session?.messages) ? session.messages : [];
  const selected = isEventList(rawMessages)
    ? selectUserMessages(rawMessages)
    : normalizePlainMessages(rawMessages);
  if (selected.length === 0) return { ...empty };

  const force = options.force === true;
  const dryRun = options.dryRun === true;
  if (!force && isSessionExtracted(db, sessionId)) return { ...empty };

  const scope = scopeOf(header);
  if (!dryRun) ensureSessionRow(db, header, sessionId, scope);

  const messages = fitMessages(selected);
  const prompt = buildExtractionMessages({ header, messages });
  const raw = await complete(prompt);
  const { facts, rejected } = parseFacts(raw, { header, messages });

  if (dryRun) {
    // 模拟 upsertFact 的合并语义，让 dry-run 的插入/更新数与真实写入一致。
    // 多值键（constraint / never-use / note / value=null）的唯一性键含 quote。
    let inserted = 0;
    let updated = 0;
    const planned = new Map();
    facts.forEach((fact) => {
      const multi = isMultiValueFact(fact);
      const quoteScoped = isQuoteScopedFact(fact);
      let planKey;
      if (quoteScoped) planKey = `${fact.key}\u0000${scope}\u0000${fact.value ?? ''}\u0000${fact.quote ?? ''}`;
      else if (multi) planKey = `${fact.key}\u0000${scope}\u0000${fact.value ?? ''}`;
      else planKey = `${fact.key}\u0000${scope}`;
      if (!planned.has(planKey)) {
        const old = activeFactFor(db, scope, fact);
        planned.set(planKey, old ? { value: old.value } : null);
      }
      const current = planned.get(planKey);
      const sameValue = current !== null
        && (multi || String(current.value ?? '') === String(fact.value ?? ''));
      if (sameValue) {
        updated += 1;
      } else {
        inserted += 1;
        planned.set(planKey, { value: fact.value });
      }
      if (typeof options.onFact === 'function') options.onFact(fact, 'dry-run');
    });
    return { inserted, updated, rejected: rejected.length };
  }

  let inserted = 0;
  let updated = 0;
  db.exec('SAVEPOINT recall_llm_extract');
  try {
    for (const fact of facts) {
      const old = activeFactFor(db, scope, fact);
      const saved = upsertFact(db, {
        key: fact.key,
        value: fact.value,
        scope,
        kind: fact.kind,
        quote: fact.quote,
        note: fact.note,
        since: fact.since,
        author: 'llm',
        verified: 1,
        evidence_session: sessionId,
        evidence_seq: fact.seq,
        span_start: fact.span_start,
        span_end: fact.span_end,
      });
      if (old && String(old.id) === String(saved.fact.id)) updated += 1;
      else inserted += 1;
      if (typeof options.onFact === 'function') options.onFact(saved.fact, 'upsert');
    }
    markSessionExtracted(db, sessionId);
    db.exec('RELEASE recall_llm_extract');
  } catch (err) {
    try {
      db.exec('ROLLBACK TO recall_llm_extract');
      db.exec('RELEASE recall_llm_extract');
    } catch {
      // 保持原始错误
    }
    throw err;
  }

  return { inserted, updated, rejected: rejected.length };
}

// ---------------------------------------------------------------------------
// 批量
// ---------------------------------------------------------------------------

function normalizeProject(value) {
  return String(value).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

function matchesProject(cwd, project) {
  if (!project) return true;
  if (typeof cwd !== 'string' || cwd === '') return false;
  return normalizeProject(cwd) === normalizeProject(project);
}

function reportProgress(callback, info) {
  if (typeof callback !== 'function') return;
  try {
    callback(info);
  } catch {
    // 进度回调不能影响抽取
  }
}

/**
 * 扫描会话目录，批量做 L2 抽取。
 *
 * 默认按文件 mtime 从新到旧处理；处理过的会话（llm_extracted_at 非空）跳过，除非 force。
 * 单个会话失败只记录错误，不中断整体。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionsRoot
 * @param {{
 *   complete: Function,
 *   maxSessions?: number,
 *   project?: string,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   onProgress?: Function,
 *   onFact?: Function,
 * }} [options]
 * @returns {Promise<{files:number, scanned:number, sessions:number, skipped:number,
 *   failed:number, calls:number, inserted:number, updated:number, rejected:number, facts:number}>}
 */
export async function extractAll(db, sessionsRoot, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('extractAll: 需要一个 SQLite 数据库实例');
  }
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new TypeError('extractAll: 需要 complete 函数');
  }

  const listed = listSessionFiles(sessionsRoot);
  const files = (Array.isArray(listed) ? listed : []).slice().sort((a, b) => (
    Number(b?.mtime ?? 0) - Number(a?.mtime ?? 0)
      || String(a?.path ?? '').localeCompare(String(b?.path ?? ''))
  ));

  const limitRaw = Number(options.maxSessions);
  const maxSessions = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.trunc(limitRaw) : Infinity;
  const force = options.force === true;
  const dryRun = options.dryRun === true;

  const stats = {
    files: files.length,
    scanned: 0,
    sessions: 0,
    skipped: 0,
    failed: 0,
    calls: 0,
    inserted: 0,
    updated: 0,
    rejected: 0,
    facts: 0,
  };

  for (let index = 0; index < files.length; index += 1) {
    if (stats.calls >= maxSessions) break;
    const file = files[index];
    stats.scanned += 1;

    const info = {
      index,
      done: index + 1,
      total: files.length,
      id: file?.id ?? null,
      path: file?.path ?? null,
      cwd: file?.cwd ?? null,
      messages: 0,
      state: 'skipped',
      facts: 0,
      inserted: 0,
      updated: 0,
      rejected: 0,
      error: null,
    };

    let parsed;
    try {
      parsed = readSessionFile(file.path);
    } catch (err) {
      stats.failed += 1;
      info.state = 'failed';
      info.error = redactSecrets(err instanceof Error ? err.message : String(err));
      console.error(`[recall] L2 抽取失败：${file?.path ?? '(unknown)'} — ${info.error}`);
      reportProgress(options.onProgress, info);
      continue;
    }

    const header = { ...(parsed?.header ?? {}) };
    if (!sessionIdOf(header) && file?.id) header.id = file.id;
    header.path = file?.path ?? header.path;

    if (isSubagentSession(header)) {
      stats.skipped += 1;
      reportProgress(options.onProgress, info);
      continue;
    }
    if (!matchesProject(header.cwd ?? file?.cwd, options.project)) {
      stats.skipped += 1;
      reportProgress(options.onProgress, info);
      continue;
    }

    const messages = selectUserMessages(parsed?.events);
    info.messages = messages.length;
    if (messages.length === 0) {
      stats.skipped += 1;
      reportProgress(options.onProgress, info);
      continue;
    }

    if (!force && isSessionExtracted(db, sessionIdOf(header))) {
      stats.skipped += 1;
      reportProgress(options.onProgress, info);
      continue;
    }

    stats.calls += 1;
    try {
      const result = await extractSessionFacts(
        db,
        { header, messages },
        { complete, force, dryRun, onFact: options.onFact },
      );
      stats.sessions += 1;
      stats.inserted += result.inserted;
      stats.updated += result.updated;
      stats.rejected += result.rejected;
      stats.facts += result.inserted + result.updated;
      info.state = 'processed';
      info.facts = result.inserted + result.updated;
      info.inserted = result.inserted;
      info.updated = result.updated;
      info.rejected = result.rejected;
    } catch (err) {
      stats.failed += 1;
      info.state = 'failed';
      info.error = redactSecrets(err instanceof Error ? err.message : String(err));
      console.error(`[recall] L2 抽取失败：${file?.path ?? '(unknown)'} — ${info.error}`);
    }
    reportProgress(options.onProgress, info);
  }

  return stats;
}

export default {
  buildExtractionMessages,
  parseFacts,
  extractSessionFacts,
  extractAll,
  selectUserMessages,
  isSubagentSession,
};
