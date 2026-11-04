/**
 * src/core/curator.js
 *
 * v2 整理管线：把一批原始轮次整理成 span（决策 / 操作 / 叙述），
 * 同一批再归组成 topic（主题），写库写文件。
 *
 * 接口（docs/design-v2.md 第 6 节，冻结）：
 *   buildSpanMessages({ turns })                  -> [{role, content}]
 *   parseSpans(raw, { turns })                    -> { spans, rejected }
 *   curateBatch(db, { scope, sessionId, turns, complete, embed, batchId })
 *                                                 -> { batchId, spans, spanIds, inserted,
 *                                                      topics, topicIds, rejectedSpans,
 *                                                      rejectedTopics, errors }
 *   curateSession(db, { sessionId, scope, turnsPerBatch, complete, embed, maxTurns })
 *                                                 -> { batches, spans, topics, ... }
 *
 * 约束：
 *   - 模型 JSON 契约冻结（design-v2 3.1 / 3.2）：只接受规定字段，坏条目丢弃。
 *   - turns / evidence 的每一个 turn 号、seq 都必须能在输入里找到，防止模型编造指针。
 *   - 本模块不读真实会话；curateSession 优先读 sessions.path 指向的会话文件以拿回
 *     reasoning / step / tool 参数，读不到再退回 events 表。
 *   - embed 可选：只有显式传入且 available 时才生成向量。
 */

import { randomUUID } from 'node:crypto';

import { attributeOf } from './chunk.js';
import { readSessionFile } from './reader.js';
import * as vectorsApi from './vectors.js';
import * as spansApi from './spans.js';
import * as topicsApi from './topics.js';

// ---------------------------------------------------------------------------
// 冻结枚举与上限
// ---------------------------------------------------------------------------

/** span 类型（design-v2 3.1） */
export const SPAN_TYPES = ['decision', 'operation', 'narrative'];

/** rationale_from 取值（design-v2 3.1） */
export const RATIONALE_FROM = ['user', 'assistant', 'reasoning', 'tool'];

/** 模型输入里只保留四类事件（任务 1） */
const SELECTED_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
]);

const MAX_SPAN_TEXT = 500; // 字
const MAX_TOPIC_DESCRIPTION = 300; // 字
const MAX_TOPIC_TITLE = 80;
const MAX_WHY = 60;

const MAX_THINKING = 800; // 字
const MAX_TOOL_ARGS = 200; // 字
const MAX_TOOL_OUTPUT = 500; // 字

const MAX_MESSAGE_CHARS = 4000;
const DEFAULT_TURNS_PER_BATCH = 5;

const SLUG_RE = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 按「字符」而不是 UTF-16 code unit 计算长度，中文/emoji 都算 1。 */
function charLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** 按字符截断。 */
function clipChars(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 单次遍历求 min/max，避免大数组 spread 爆栈。 */
function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  let seen = false;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    seen = true;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return seen ? { min, max } : null;
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) return trimmed.slice(3).replace(/```\s*$/, '').trim();
  return trimmed.slice(firstBreak + 1).replace(/```\s*$/, '').trim();
}

/** 模型返回对象 / JSON 字符串（可带围栏）→ JS 对象。无法解析时抛错。 */
function parseJsonObject(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string') {
    throw new TypeError('curator: 模型返回必须是对象或 JSON 字符串');
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
      // 试下一种候选
    }
  }
  throw new Error('curator: 模型返回无法解析为 JSON');
}

// ---------------------------------------------------------------------------
// turn / 事件输入归一化
// ---------------------------------------------------------------------------

function turnNumberOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * 归一化 buildSpanMessages / parseSpans 共用的 turns 输入。
 * 只保留有合法 turn 号的轮次；按 turn 升序（prompt 要求真实时间顺序）。
 * @param {Array<{turn:number, events:object[]}>} turns
 */
function normalizeTurnsInput(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const byTurn = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const turn = turnNumberOf(item.turn ?? item.turn_number ?? item.n);
    if (turn === null) continue;
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    const events = Array.isArray(item.events) ? item.events : [];
    byTurn.get(turn).push(...events);
  }
  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, events]) => ({ turn, events }));
}

/** 渲染一条事件（可能返回多行：正文 + 思考）。 */
function renderEventLines(event) {
  const seqRaw = Number(event?.seq);
  const seq = Number.isFinite(seqRaw) ? String(Math.trunc(seqRaw)) : '?';
  const type = typeof event?.type === 'string' ? event.type : 'event';
  const text = typeof event?.text === 'string' ? event.text.trim() : '';
  const lines = [];

  if (type === 'tool/call') {
    const tool = typeof event?.tool === 'string' && event.tool.trim() !== ''
      ? event.tool.trim()
      : '';
    const args = typeof event?.args === 'string' ? event.args.trim() : '';
    const inline = tool ? `${tool}${args ? ` ${args}` : ''}` : text;
    if (inline !== '') lines.push(`seq ${seq} · 工具调用：${clipChars(inline, MAX_MESSAGE_CHARS)}`);
  } else if (type === 'tool/result') {
    const output = typeof event?.output === 'string' && event.output.trim() !== ''
      ? event.output.trim()
      : text;
    if (output !== '') lines.push(`seq ${seq} · 工具结果：${clipChars(output, MAX_TOOL_OUTPUT)}`);
  } else if (type === 'user/message') {
    if (text !== '') lines.push(`seq ${seq} · 用户：${clipChars(text, MAX_MESSAGE_CHARS)}`);
  } else if (type === 'assistant/message') {
    if (text !== '') lines.push(`seq ${seq} · 助手：${clipChars(text, MAX_MESSAGE_CHARS)}`);
  }

  const thinking = typeof event?.thinking === 'string' ? event.thinking.trim() : '';
  if (type === 'assistant/message' && thinking !== '') {
    lines.push(`seq ${seq} · 思考：${clipChars(thinking, MAX_THINKING)}`);
  }
  return lines;
}

function renderTurnBlock({ turn, events }) {
  const lines = [];
  for (const event of events) lines.push(...renderEventLines(event));
  const seqs = events
    .map((event) => Number(event?.seq))
    .filter((seq) => Number.isFinite(seq))
    .map((seq) => Math.trunc(seq));
  const bounds = minMax(seqs);
  const range = bounds ? `，seq ${bounds.min}–${bounds.max}` : '';
  return `第 ${turn} 轮${range}\n${lines.length > 0 ? lines.join('\n') : '（本轮无可整理内容）'}`;
}

// ---------------------------------------------------------------------------
// Prompt 1：span 抽取
// ---------------------------------------------------------------------------

/**
 * system prompt，严格按 design-v2 3.1 的规则写。中文正文控制在 800 字以内。
 */
const SPAN_SYSTEM_PROMPT = `你是「项目记忆整理器」：把一批带轮次和 seq 的对话整理成 span（语义单元），只输出 JSON。

span 的 type 只能是 decision|operation|narrative，三种含义：
- decision：技术或方向层面的取舍，例如「决定 TTS 情感参数走独立配置文件」。
- operation：做过的事，按 step 合并。同一个 step 里的所有工具调用写成一条，只记输入、输出和一句极简描述；相邻且中间没有实质内容的 step 可以合并。大段读文件归到这里。
- narrative：用户偏好/习惯、我们做了什么、目标和手头材料。用户讲了喜欢的水果和香水类型及原因，要写「描述了他喜欢的水果类型和香水类型及原因」，不能写「表达了一些喜好」；既不能漏，也不能过细。

规则：
- 按真实时间顺序输出。
- turns 是涉及的轮次，可以是多个（跨轮合并），例如 [7,9]。evidence 里每个 seq 都必须来自这些轮次的事件，不能编造。
- rationale_from 标明理由来自哪里，只能是 user|assistant|reasoning|tool。
- text 是一句概括（≤500 字），必须能被 evidence 支撑；可以改写，不能编造。
- 没有可整理的就返回 {"spans":[]}。宁可空，不要编。

只输出 JSON，不要解释：
{"spans":[{"type":"decision","text":"决定 TTS 情感参数走独立配置文件","turns":[7],"evidence":[{"seq":8121,"turn":7}],"rationale_from":"reasoning"}]}`;

/**
 * 构造 span 抽取 prompt。
 * @param {{ turns?: Array<{turn:number, events:object[]}>, scope?: string, sessionId?: string }} input
 * @returns {Array<{role:'system'|'user', content:string}>}
 */
export function buildSpanMessages(input = {}) {
  const turns = normalizeTurnsInput(input?.turns);
  const scope = typeof input?.scope === 'string' && input.scope.trim() !== ''
    ? input.scope.trim()
    : 'unknown';
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId.trim() !== ''
    ? input.sessionId.trim()
    : '';

  const header = [`项目：${scope}`];
  if (sessionId) header.push(`会话：${sessionId}`);
  const blocks = turns.length > 0
    ? turns.map(renderTurnBlock)
    : ['（这一批没有可用事件）'];

  return [
    { role: 'system', content: SPAN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [...header, '', '对话（每行前缀是该事件的 seq）：', ...blocks].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// 解析 1：span 校验
// ---------------------------------------------------------------------------

function buildSeqTurnMap(turns) {
  const seqTurn = new Map();
  const turnSet = new Set();
  for (const item of turns) {
    turnSet.add(item.turn);
    for (const event of item.events) {
      const seq = turnNumberOf(event?.seq);
      if (seq === null) continue;
      // 同一 seq 正常只属于一轮；冲突时保留第一次出现的轮次
      if (!seqTurn.has(seq)) seqTurn.set(seq, item.turn);
    }
  }
  return { seqTurn, turnSet };
}

/**
 * 校验并归一化模型返回的 span。
 *
 * 丢弃规则（任务 1）：
 *   - type 不在 decision|operation|narrative
 *   - text 为空或超过 500 字
 *   - turns 为空 / 有不在输入里的轮次
 *   - evidence 的 seq 不在这些轮次的事件里（或格式坏）
 * rationale_from 不在枚举 → null（不丢整条）。
 *
 * @param {object|string} raw
 * @param {{ turns?: Array<{turn:number, events:object[]}> }} input
 * @returns {{ spans: object[], rejected: Array<{reason:string, span:any}> }}
 */
export function parseSpans(raw, input = {}) {
  const turns = normalizeTurnsInput(input?.turns);
  const { seqTurn, turnSet } = buildSeqTurnMap(turns);

  let parsed;
  try {
    parsed = parseJsonObject(raw);
  } catch {
    return { spans: [], rejected: [{ reason: 'invalid_json', span: null }] };
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.spans;
  if (!Array.isArray(list)) {
    return { spans: [], rejected: [{ reason: 'spans_not_array', span: parsed }] };
  }

  const spans = [];
  const rejected = [];

  for (const item of list) {
    if (!isPlainObject(item)) {
      rejected.push({ reason: 'invalid_span', span: item });
      continue;
    }

    const type = typeof item.type === 'string' ? item.type.trim() : '';
    if (!SPAN_TYPES.includes(type)) {
      rejected.push({ reason: 'bad_type', span: item });
      continue;
    }

    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') {
      rejected.push({ reason: 'empty_text', span: item });
      continue;
    }
    if (charLength(text) > MAX_SPAN_TEXT) {
      rejected.push({ reason: 'text_too_long', span: item });
      continue;
    }

    const rawTurns = Array.isArray(item.turns) ? item.turns : [];
    if (rawTurns.length === 0) {
      rejected.push({ reason: 'turn_not_found', span: item });
      continue;
    }
    const spanTurns = [];
    let turnsOk = true;
    for (const value of rawTurns) {
      const turn = turnNumberOf(value);
      if (turn === null || !turnSet.has(turn)) {
        turnsOk = false;
        break;
      }
      spanTurns.push(turn);
    }
    if (!turnsOk) {
      rejected.push({ reason: 'turn_not_found', span: item });
      continue;
    }
    const turnNumbers = [...new Set(spanTurns)].sort((a, b) => a - b);

    // evidence：可以缺省（[]），但只要给了就必须每一条都能落到这些轮次的事件上
    const evidence = [];
    if (item.evidence !== undefined && item.evidence !== null) {
      if (!Array.isArray(item.evidence)) {
        rejected.push({ reason: 'bad_evidence', span: item });
        continue;
      }
      const allowedTurns = new Set(turnNumbers);
      const seenSeq = new Set();
      let evidenceOk = true;
      for (const entry of item.evidence) {
        if (!isPlainObject(entry)) {
          evidenceOk = false;
          break;
        }
        const seq = turnNumberOf(entry.seq);
        if (seq === null) {
          evidenceOk = false;
          break;
        }
        const actualTurn = seqTurn.get(seq);
        if (actualTurn === undefined || !allowedTurns.has(actualTurn)) {
          evidenceOk = false;
          break;
        }
        if (seenSeq.has(seq)) continue;
        seenSeq.add(seq);
        evidence.push({ seq, turn: actualTurn });
      }
      if (!evidenceOk) {
        rejected.push({ reason: 'evidence_not_found', span: item });
        continue;
      }
      evidence.sort((a, b) => a.seq - b.seq);
    }

    const rationaleFrom = RATIONALE_FROM.includes(item.rationale_from)
      ? item.rationale_from
      : null;

    spans.push({
      type,
      text,
      turns: turnNumbers,
      evidence,
      rationale_from: rationaleFrom,
    });
  }

  // 真实时间顺序：先按最早轮次，再按最早 evidence seq（稳定排序）
  spans.sort((a, b) => (
    (a.turns[0] ?? 0) - (b.turns[0] ?? 0)
      || (a.evidence[0]?.seq ?? 0) - (b.evidence[0]?.seq ?? 0)
  ));

  return { spans, rejected };
}

// ---------------------------------------------------------------------------
// Prompt 2：主题归组
// ---------------------------------------------------------------------------

const TOPIC_SYSTEM_PROMPT = `你是「主题归组器」：把本次新增的 span 归入主题（topic），只输出 JSON。

规则：
- 分类只看内容，与 span 类型无关；同一个 span 可以出现在多个主题。
- 优先复用已有主题；只有内容明显不同才新建。slug 只能含小写字母、数字和连字符（[a-z0-9-]），如 tts-emotion。
- description 不超过 300 字，要写出「这个主题下有哪些内容」，不能只写标题。
- span_ids 只能从输入给出的 id 里选，至少 1 条。
- 只输出涉及本次新增 span 的主题；没有就返回 {"topics":[]}。
- title 用简短中文。

只输出 JSON，不要解释：
{"topics":[{"slug":"tts-emotion","title":"TTS 情感与显存","description":"这个主题收了 5 条：情感参数导致显存溢出的排查、降 batch 的决定、配置文件的方案……","span_ids":["sp_1","sp_2"]}]}`;

/** 把 listTopics 的行归一化成 {slug,title,description,span_ids}。 */
function normalizeExistingTopics(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    if (!isPlainObject(row)) continue;
    const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
    if (slug === '') continue;
    out.push({
      id: typeof row.id === 'string' ? row.id : null,
      scope: typeof row.scope === 'string' ? row.scope : null,
      slug,
      title: typeof row.title === 'string' ? row.title.trim() : '',
      description: typeof row.description === 'string' ? row.description.trim() : '',
      span_ids: parseSpanIdList(row.span_ids),
      file: typeof row.file === 'string' ? row.file : null,
    });
  }
  return out;
}

/** topics.span_ids 可能是数组也可能是 JSON 字符串。 */
function parseSpanIdList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item !== '');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item) => typeof item === 'string' && item !== '');
      }
    } catch {
      // 不是 JSON：当作单个 id
      return [value.trim()];
    }
  }
  return [];
}

/**
 * 构造主题归组 prompt。
 * @param {{ spans: Array<{id:string,type:string,text:string,turns:number[]}>,
 *           topics?: object[] }} input
 */
export function buildTopicMessages(input = {}) {
  const spans = Array.isArray(input?.spans) ? input.spans : [];
  const topics = normalizeExistingTopics(input?.topics);

  const existingLines = topics.length > 0
    ? topics.map((topic) => (
      `- ${topic.slug} | ${topic.title || '(无标题)'} | ${topic.description || '(无描述)'}`
    ))
    : ['（暂无）'];
  const spanLines = spans.length > 0
    ? spans.map((span) => (
      `- ${span.id} | ${span.type} | 轮次 ${(span.turns ?? []).join(',')} | ${span.text}`
    ))
    : ['（无）'];

  return [
    { role: 'system', content: TOPIC_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '现有主题（slug | title | description）：',
        ...existingLines,
        '',
        '新增 span（id | type | turns | text）：',
        ...spanLines,
        '',
        '请把新增 span 归入主题，输出 JSON。',
      ].join('\n'),
    },
  ];
}

/**
 * 校验并归一化主题归组结果。
 *
 * 校验（任务 1）：
 *   - span_ids 只能来自「本次新增 span + 该主题已有 span」
 *   - description 超过 300 字截断
 *   - slug 只允许 [a-z0-9-]；非法主题整条丢弃
 * 已有主题会被合并（保留原 span_ids），description/title 用模型的新值。
 *
 * @param {object|string} raw
 * @param {{ spans?: object[], existingTopics?: object[] }} input
 */
export function parseTopics(raw, input = {}) {
  let parsed;
  try {
    parsed = parseJsonObject(raw);
  } catch {
    return { topics: [], rejected: [{ reason: 'invalid_json', topic: null }] };
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.topics;
  if (!Array.isArray(list)) {
    return { topics: [], rejected: [{ reason: 'topics_not_array', topic: parsed }] };
  }

  const newSpans = (Array.isArray(input?.spans) ? input.spans : [])
    .filter((span) => isPlainObject(span) && typeof span.id === 'string' && span.id !== '');
  const newIds = new Set(newSpans.map((span) => span.id));
  const existing = normalizeExistingTopics(input?.existingTopics);
  const existingBySlug = new Map(existing.map((topic) => [topic.slug, topic]));

  const merged = new Map();
  const rejected = [];

  for (const item of list) {
    if (!isPlainObject(item)) {
      rejected.push({ reason: 'invalid_topic', topic: item });
      continue;
    }

    const slug = typeof item.slug === 'string' ? item.slug.trim().toLowerCase() : '';
    if (!SLUG_RE.test(slug)) {
      rejected.push({ reason: 'bad_slug', topic: item });
      continue;
    }

    const prior = existingBySlug.get(slug) ?? null;
    const allowed = new Set(newIds);
    if (prior) for (const id of prior.span_ids) allowed.add(id);

    const rawIds = Array.isArray(item.span_ids) ? item.span_ids : [];
    const spanIds = [];
    const seenIds = new Set();
    let droppedIds = 0;
    for (const value of rawIds) {
      const id = typeof value === 'string' ? value.trim() : '';
      if (id === '' || !allowed.has(id)) {
        droppedIds += 1;
        continue;
      }
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      spanIds.push(id);
    }
    if (spanIds.length === 0) {
      rejected.push({ reason: 'no_span_ids', topic: item, dropped: droppedIds });
      continue;
    }
    // 已有主题：保留原来的 span，避免模型只列新增的就把旧 span 挤掉
    if (prior) {
      for (const id of prior.span_ids) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        spanIds.push(id);
      }
    }

    let title = typeof item.title === 'string' ? item.title.trim() : '';
    if (title === '') title = prior?.title ?? slug;
    title = clipChars(title, MAX_TOPIC_TITLE);

    let description = typeof item.description === 'string' ? item.description.trim() : '';
    if (description === '') description = prior?.description ?? '';
    description = clipChars(description, MAX_TOPIC_DESCRIPTION);

    const current = merged.get(slug);
    if (current) {
      // 模型重复给出同一 slug：并集，后一条优先更新描述
      for (const id of spanIds) {
        if (!current.span_ids.includes(id)) current.span_ids.push(id);
      }
      if (title !== '') current.title = title;
      if (description !== '') current.description = description;
      continue;
    }

    merged.set(slug, {
      id: prior?.id ?? null,
      slug,
      title,
      description,
      span_ids: spanIds,
      file: prior?.file ?? null,
      existing: Boolean(prior),
      dropped_span_ids: droppedIds,
    });
  }

  return { topics: [...merged.values()], rejected };
}

// ---------------------------------------------------------------------------
// 向量（可选）
// ---------------------------------------------------------------------------

/**
 * 兼容几种 embed 传法：
 *   - 函数：embed(texts) -> vectors（模型名视为未知）
 *   - { cfg, embedTexts } / { cfg, embed }
 *   - { available, model, embedTexts } / { available, model, embed }
 * available === false 或没有可调用函数 -> null。
 */
function resolveEmbedder(embed) {
  if (typeof embed === 'function') {
    return { available: true, model: null, embed: (texts) => embed(texts) };
  }
  if (!isPlainObject(embed)) return null;
  const cfg = isPlainObject(embed.cfg) ? embed.cfg : embed;
  if (cfg.available === false) return null;
  if (typeof embed.embed === 'function') {
    return { available: true, model: cfg.model ?? null, embed: (texts) => embed.embed(texts) };
  }
  if (typeof embed.embedTexts === 'function') {
    return {
      available: true,
      model: cfg.model ?? null,
      embed: (texts) => embed.embedTexts(texts, cfg),
    };
  }
  // 只传了 config（如 resolveEmbeddingConfig() 的返回值）：用 vectors.js 的默认实现。
  if (cfg.available === true) {
    return {
      available: true,
      model: cfg.model ?? null,
      embed: (texts) => vectorsApi.embedTexts(texts, cfg),
    };
  }
  return null;
}

function toVectorRow(ownerKey, ownerId, model, vector) {
  if (!vector || typeof vector.length !== 'number' || vector.length === 0) return null;
  return {
    [ownerKey]: ownerId,
    model: String(model ?? 'unknown'),
    dim: vector.length,
    vec: vector,
  };
}

/**
 * 给新 span / topic 生成向量。任何失败都吞掉——向量是增强，不是整理的前置条件。
 * @returns {Promise<{spans:number, topics:number}>}
 */
async function applyEmbeddings(db, { embed, spans, topics }) {
  const embedder = resolveEmbedder(embed);
  const result = { spans: 0, topics: 0 };
  if (!embedder) return result;

  const spanList = Array.isArray(spans) ? spans.filter((span) => span?.id) : [];
  if (spanList.length > 0 && typeof vectorsApi.saveSpanVectors === 'function') {
    try {
      const vectors = await embedder.embed(spanList.map((span) => span.text));
      if (Array.isArray(vectors) && vectors.length === spanList.length) {
        const rows = vectors
          .map((vector, index) => toVectorRow('span_id', spanList[index].id, embedder.model, vector))
          .filter(Boolean);
        if (rows.length > 0) {
          vectorsApi.saveSpanVectors(db, rows);
          result.spans = rows.length;
        }
      }
    } catch {
      // 忽略：向量生成失败不影响 span 入库
    }
  }

  const topicList = Array.isArray(topics) ? topics.filter((topic) => topic?.id) : [];
  if (topicList.length > 0 && typeof vectorsApi.saveTopicVectors === 'function') {
    try {
      const vectors = await embedder.embed(topicList.map(
        (topic) => `${topic.title ?? ''}\n${topic.description ?? ''}`.trim(),
      ));
      if (Array.isArray(vectors) && vectors.length === topicList.length) {
        const rows = vectors
          .map((vector, index) => toVectorRow('topic_id', topicList[index].id, embedder.model, vector))
          .filter(Boolean);
        if (rows.length > 0) {
          vectorsApi.saveTopicVectors(db, rows);
          result.topics = rows.length;
        }
      }
    } catch {
      // 忽略
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

function makeSpanId() {
  return `sp_${randomUUID()}`;
}

/**
 * insertSpans 返回的 ids 可能缺失/顺序不可靠：优先按 batch_id 回查数据库，
 * 再退回返回值，最后退回本地生成的 id。
 */
function resolveInsertedIds(db, batchId, records, insertResult) {
  try {
    const rows = db.prepare('SELECT id FROM spans WHERE batch_id = ? ORDER BY rowid').all(batchId);
    if (Array.isArray(rows) && rows.length === records.length) {
      return rows.map((row) => row.id);
    }
  } catch {
    // spans 表不存在 / 没写 batch_id：继续用返回值
  }

  const returned = Array.isArray(insertResult?.ids) ? insertResult.ids : [];
  if (returned.length === records.length) {
    return returned.map((value) => (
      typeof value === 'string' ? value : (value?.id ?? value?.span_id ?? null)
    ));
  }
  return records.map((record) => record.id);
}

function lookupTopicId(db, scope, slug) {
  try {
    const row = db.prepare('SELECT id FROM topics WHERE scope = ? AND slug = ?').get(scope, slug);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** 记录一次整理（curations 表）；失败不影响主流程。 */
function recordCuration(db, { scope, sessionId, turns, spanCount, topicCount }) {
  try {
    const seqs = [];
    for (const turn of turns) {
      for (const event of turn.events) {
        const seq = turnNumberOf(event?.seq);
        if (seq !== null) seqs.push(seq);
      }
    }
    const bounds = minMax(seqs);
    const fromSeq = bounds ? bounds.min : null;
    const toSeq = bounds ? bounds.max : null;
    db.prepare(`
      INSERT INTO curations (id, scope, session_id, from_seq, to_seq, spans, topics, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scope, sessionId ?? null, fromSeq, toSeq, spanCount, topicCount, Date.now());
  } catch {
    // 旧库没有 curations 表 / 写入失败都不影响 span
  }
}

// ---------------------------------------------------------------------------
// curateBatch：一批 turn -> span + topic
// ---------------------------------------------------------------------------

/**
 * 整理一批 turn：抽取 span 入库，再用同一批做主题归组。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   scope: string,
 *   sessionId?: string,
 *   turns: Array<{turn:number, events:object[]}>,
 *   complete: (messages: Array<{role:string,content:string}>) => Promise<object|string>,
 *   embed?: Function|object,
 *   batchId?: string,
 *   dryRun?: boolean,
 *   topicDir?: string,          // 覆盖 topic md 目录（测试传 tmpdir）
 * }} options
 */
export async function curateBatch(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('curateBatch: 需要一个 SQLite 数据库实例');
  }
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new TypeError('curateBatch: 需要 complete 函数');
  }

  const scope = typeof options.scope === 'string' && options.scope.trim() !== ''
    ? options.scope.trim()
    : 'global';
  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== ''
    ? options.sessionId
    : null;
  const batchId = typeof options.batchId === 'string' && options.batchId !== ''
    ? options.batchId
    : randomUUID();
  const dryRun = options.dryRun === true;
  const turns = normalizeTurnsInput(options.turns);

  const empty = {
    batchId,
    spans: [],
    spanIds: [],
    inserted: 0,
    rejectedSpans: 0,
    topics: [],
    topicIds: [],
    rejectedTopics: 0,
    embedded: { spans: 0, topics: 0 },
    errors: [],
    dryRun,
  };
  if (turns.length === 0) return empty;

  const messages = buildSpanMessages({ turns, scope, sessionId });
  const raw = await complete(messages);
  const { spans, rejected } = parseSpans(raw, { turns });

  if (dryRun) {
    return {
      ...empty,
      spans: spans.map((span) => ({ ...span, id: null })),
      inserted: 0,
      rejectedSpans: rejected.length,
    };
  }

  if (spans.length === 0) {
    return {
      ...empty,
      rejectedSpans: rejected.length,
    };
  }

  const records = spans.map((span) => ({
    id: makeSpanId(),
    scope,
    type: span.type,
    text: span.text,
    turns: span.turns,
    evidence: span.evidence.map((entry) => (
      sessionId ? { session_id: sessionId, seq: entry.seq, turn: entry.turn } : entry
    )),
    rationale_from: span.rationale_from,
    batch_id: batchId,
    session_ids: sessionId ? [sessionId] : [],
    created_at: Date.now(),
  }));

  if (typeof spansApi.insertSpans !== 'function') {
    throw new Error('curateBatch: src/core/spans.js 缺少 insertSpans');
  }
  const insertResult = spansApi.insertSpans(db, records);
  const insertedCount = Number(insertResult?.inserted);
  const spanIds = resolveInsertedIds(db, batchId, records, insertResult);
  const newSpans = records.map((record, index) => ({
    id: spanIds[index],
    type: record.type,
    text: record.text,
    turns: record.turns,
  }));

  // 第二次模型调用：主题归组（失败不拖垮本批 span）
  const errors = [];
  let parsedTopics = { topics: [], rejected: [] };
  let existingTopics = [];
  try {
    if (typeof topicsApi.listTopics !== 'function') {
      throw new Error('src/core/topics.js 缺少 listTopics');
    }
    if (typeof topicsApi.upsertTopic !== 'function') {
      throw new Error('src/core/topics.js 缺少 upsertTopic');
    }
    existingTopics = normalizeExistingTopics(topicsApi.listTopics(db, { scope }));
    const topicRaw = await complete(buildTopicMessages({ spans: newSpans, topics: existingTopics }));
    parsedTopics = parseTopics(topicRaw, { spans: newSpans, existingTopics });
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  const writtenTopics = [];
  for (const topic of parsedTopics.topics) {
    const payload = {
      scope,
      slug: topic.slug,
      title: topic.title,
      description: topic.description,
      span_ids: topic.span_ids,
    };
    if (topic.id) payload.id = topic.id;
    if (topic.file) payload.file = topic.file;

    try {
      const saved = typeof options.topicDir === 'string' && options.topicDir !== ''
        ? topicsApi.upsertTopic(db, payload, { dir: options.topicDir })
        : topicsApi.upsertTopic(db, payload);
      const topicId = saved?.id
        ?? saved?.topic?.id
        ?? topic.id
        ?? lookupTopicId(db, scope, topic.slug);
      writtenTopics.push({
        ...topic,
        id: topicId ?? null,
        file: saved?.file ?? topic.file ?? null,
        git: saved?.git,
        committed: saved?.committed,
        merge: saved?.merge,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const embedded = await applyEmbeddings(db, { embed: options.embed, spans: newSpans, topics: writtenTopics });

  recordCuration(db, {
    scope,
    sessionId,
    turns,
    spanCount: Number.isFinite(insertedCount) ? insertedCount : newSpans.length,
    topicCount: writtenTopics.length,
  });

  return {
    batchId,
    spans: newSpans,
    spanIds,
    inserted: Number.isFinite(insertedCount) ? insertedCount : newSpans.length,
    rejectedSpans: rejected.length,
    topics: writtenTopics,
    topicIds: writtenTopics.map((topic) => topic.id).filter(Boolean),
    rejectedTopics: parsedTopics.rejected.length,
    embedded,
    errors,
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// 原始事件 -> turn 分组
// ---------------------------------------------------------------------------

function collectText(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value !== '') out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return;
  }
  if (typeof value !== 'object') return;

  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'reasoning' || type === 'thinking' || type === 'redacted_thinking') return;
  if (type === 'tool-call' || type === 'tool_call' || type === 'tool_use' || type === 'tool-use') {
    return;
  }
  if (type === 'tool-result' || type === 'tool_result'
    || type === 'tool-output' || type === 'tool_output') {
    collectText(value.content ?? value.result ?? value.output, out);
    return;
  }
  if (type === 'text') {
    if (typeof value.text === 'string' && value.text !== '') out.push(value.text);
    return;
  }
  if (typeof value.text === 'string' && value.text !== '') {
    out.push(value.text);
    return;
  }
  if (value.content !== undefined) {
    collectText(value.content, out);
    return;
  }
  if (value.message !== undefined) collectText(value.message, out);
}

/** 从 content（字符串 / parts / 嵌套对象）取纯文本，跳过 reasoning。 */
function contentText(value) {
  const out = [];
  collectText(value, out);
  return out.join('\n');
}

function collectReasoning(value, out) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectReasoning(item, out);
    return;
  }
  if (typeof value !== 'object') return;

  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'reasoning' || type === 'thinking' || type === 'redacted_thinking') {
    if (typeof value.text === 'string' && value.text !== '') out.push(value.text);
    else if (typeof value.reasoning === 'string' && value.reasoning !== '') out.push(value.reasoning);
    return;
  }
  if (value.content !== undefined) collectReasoning(value.content, out);
  if (value.message !== undefined) collectReasoning(value.message, out);
}

function roleOf(event, type) {
  if (typeof event?.author === 'string' && event.author !== '') return event.author;
  try {
    const role = attributeOf(event);
    if (typeof role === 'string' && role !== '') return role;
  } catch {
    // 忽略
  }
  if (type === 'user/message') return 'user';
  if (type === 'assistant/message') return 'assistant';
  if (type === 'tool/call' || type === 'tool/result') return 'tool';
  return 'system';
}

/**
 * 把一条原始事件归一化成 prompt 事件
 * {seq, type, role, text, thinking?, tool?, args?, output?}。
 * 没有任何内容的事件返回 null。
 */
function normalizeEventForPrompt(event, type) {
  if (!event || typeof event !== 'object') return null;
  if (!SELECTED_EVENT_TYPES.has(type)) return null;

  const seq = turnNumberOf(event?.seq);
  const out = {
    seq: seq === null ? null : seq,
    type,
    role: roleOf(event, type),
  };

  const data = isPlainObject(event?.data) ? event.data : null;
  if (data) {
    if (type === 'user/message') {
      out.text = contentText(data.content ?? data.text).trim();
    } else if (type === 'assistant/message') {
      const body = data.message ?? data.content ?? data.text;
      out.text = contentText(body).trim();
      const thinking = [];
      collectReasoning(body, thinking);
      const reasoning = thinking.join('\n').trim();
      if (reasoning !== '') out.thinking = clipChars(reasoning, MAX_THINKING);
    } else if (type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : '';
      const args = data.arguments ?? data.args ?? {};
      const argsText = typeof args === 'string' ? args : safeJson(args);
      out.tool = name;
      out.args = clipChars(argsText, MAX_TOOL_ARGS);
      out.text = [name, out.args].filter(Boolean).join(' ').trim();
    } else if (type === 'tool/result') {
      const body = data.message ?? data.content ?? data.result ?? data.text;
      out.output = clipChars(contentText(body).trim(), MAX_TOOL_OUTPUT);
    }
  } else {
    const text = typeof event?.text === 'string' ? event.text.trim() : '';
    if (text !== '') {
      if (type === 'tool/call') {
        const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
        out.tool = match?.[1] ?? '';
        out.args = clipChars(match?.[2] ?? '', MAX_TOOL_ARGS);
        out.text = [out.tool, out.args].filter(Boolean).join(' ').trim();
      } else if (type === 'tool/result') {
        out.output = clipChars(text, MAX_TOOL_OUTPUT);
      } else {
        out.text = clipChars(text, MAX_MESSAGE_CHARS);
      }
    }
  }

  const hasContent = Boolean(
    (typeof out.text === 'string' && out.text.trim() !== '')
      || (typeof out.thinking === 'string' && out.thinking !== '')
      || (typeof out.tool === 'string' && out.tool !== '')
      || (typeof out.output === 'string' && out.output !== ''),
  );
  return hasContent ? out : null;
}

/**
 * 按 turn/start 的 data.turn 分组；只有四类事件进入结果。
 * 没有 turn 信号时退回「一条 user/message 开一轮」。
 * @param {object[]} events
 * @returns {Array<{turn:number, events:object[]}>}
 */
export function groupTurns(events) {
  const list = Array.isArray(events) ? events : [];
  const hasTurnSignal = list.some((event) => (
    event?.type === 'turn/start' || turnNumberOf(event?.data?.turn) !== null
  ));

  const byTurn = new Map();
  let current = 1;
  let seenTurnStart = false;
  let derivedTurns = 0;

  for (const event of list) {
    const type = typeof event?.type === 'string' ? event.type : '';
    const dataTurn = turnNumberOf(event?.data?.turn);
    if (dataTurn !== null) {
      current = dataTurn;
      if (type === 'turn/start') seenTurnStart = true;
    } else if (type === 'turn/start') {
      if (!seenTurnStart) {
        seenTurnStart = true;
        current = 1;
      } else {
        current += 1;
      }
    } else if (!hasTurnSignal) {
      if (type === 'user/message') {
        derivedTurns += 1;
        current = derivedTurns;
      }
    }

    const turn = current;
    const record = normalizeEventForPrompt(event, type);
    if (!record) continue;
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push(record);
  }

  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, events]) => ({ turn, events }));
}

/** 从会话文件或 events 表读原始事件；读文件是为了拿到 reasoning / step / 工具参数。 */
function loadSessionEvents(db, sessionId, provided) {
  if (Array.isArray(provided)) return { events: provided, source: 'provided' };

  let row = null;
  try {
    row = db.prepare('SELECT path FROM sessions WHERE id = ?').get(sessionId) ?? null;
  } catch {
    row = null;
  }
  if (typeof row?.path === 'string' && row.path !== '') {
    try {
      const parsed = readSessionFile(row.path);
      if (Array.isArray(parsed?.events)) {
        return { events: parsed.events, source: 'session-file' };
      }
    } catch {
      // 会话文件损坏/被移走：退回 events 表
    }
  }

  let rows = [];
  try {
    rows = db.prepare(
      'SELECT seq, type, author, text, time FROM events WHERE session_id = ? ORDER BY seq',
    ).all(sessionId);
  } catch {
    rows = [];
  }
  return { events: rows, source: 'db' };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

// ---------------------------------------------------------------------------
// curateSession：整段会话按批整理
// ---------------------------------------------------------------------------

/**
 * 整理一个会话：读事件 -> 按 turn 分组 -> 每 turnsPerBatch 轮一批 -> 汇总统计。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   sessionId: string,
 *   scope?: string,
 *   turnsPerBatch?: number,
 *   complete: Function,
 *   embed?: Function|object,
 *   maxTurns?: number,
 *   dryRun?: boolean,
 *   topicDir?: string,
 *   events?: object[],          // 测试/调用方可直接给原始事件，跳过读库
 *   onBatch?: (info: object) => void,
 * }} options
 */
export async function curateSession(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('curateSession: 需要一个 SQLite 数据库实例');
  }
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new TypeError('curateSession: 需要 complete 函数');
  }
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (sessionId === '') throw new Error('curateSession: sessionId 缺失');

  const scope = typeof options.scope === 'string' && options.scope.trim() !== ''
    ? options.scope.trim()
    : 'global';
  const turnsPerBatch = toPositiveInt(options.turnsPerBatch, DEFAULT_TURNS_PER_BATCH);
  const maxTurnsRaw = Number(options.maxTurns);
  const maxTurns = Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0
    ? Math.trunc(maxTurnsRaw)
    : Infinity;
  const dryRun = options.dryRun === true;
  const { events, source } = loadSessionEvents(db, sessionId, options.events);
  const allTurns = groupTurns(events);
  const turns = maxTurns === Infinity ? allTurns : allTurns.slice(-maxTurns);

  const stats = {
    sessionId,
    scope,
    source,
    turns: turns.length,
    batches: 0,
    spans: 0,
    topics: 0,
    inserted: 0,
    rejectedSpans: 0,
    rejectedTopics: 0,
    failures: 0,
    errors: [],
    spanList: [],
    batchList: [],
  };

  for (let index = 0; index < turns.length; index += turnsPerBatch) {
    const batchTurns = turns.slice(index, index + turnsPerBatch);
    try {
      const result = await curateBatch(db, {
        scope,
        sessionId,
        turns: batchTurns,
        complete,
        embed: options.embed,
        topicDir: options.topicDir,
        dryRun,
      });
      stats.batches += 1;
      stats.spans += result.spans.length;
      stats.inserted += Number(result.inserted) || 0;
      stats.topics += result.topics.length;
      stats.rejectedSpans += result.rejectedSpans;
      stats.rejectedTopics += result.rejectedTopics;
      stats.spanList.push(...result.spans);
      stats.batchList.push(result);
      for (const error of result.errors ?? []) stats.errors.push(error);
      if (typeof options.onBatch === 'function') {
        try {
          options.onBatch({ index: stats.batches, turns: batchTurns, result });
        } catch {
          // 进度回调不能影响整理
        }
      }
    } catch (err) {
      stats.failures += 1;
      stats.errors.push(err instanceof Error ? err : new Error(String(err)));
      if (typeof options.onBatch === 'function') {
        try {
          options.onBatch({ index: index / turnsPerBatch + 1, turns: batchTurns, error: err });
        } catch {
          // 同上
        }
      }
    }
  }

  return stats;
}

export default {
  buildSpanMessages,
  parseSpans,
  buildTopicMessages,
  parseTopics,
  curateBatch,
  curateSession,
  groupTurns,
  SPAN_TYPES,
  RATIONALE_FROM,
};
