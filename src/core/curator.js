// curator：把一批 turn 整理成 span（决策 / 操作 / 叙述）并归入 topic；写库 + 写主题 md。
// 接口冻结见 docs/design-v2.md 第 6 节；事件来源由调用方给 events 或 sessionPath。
import { randomUUID } from 'node:crypto';
import { attributeOf } from './chunk.js';
import { readSessionFile } from './reader.js';
import * as vectorsApi from './vectors.js';
import * as spansApi from './spans.js';
import * as topicsApi from './topics.js';
export const SPAN_TYPES = ['decision', 'operation', 'narrative'];
export const RATIONALE_FROM = ['user', 'assistant', 'reasoning', 'tool'];
const SELECTED_EVENT_TYPES = new Set([ 'user/message', 'assistant/message', 'tool/call', 'tool/result', ]);
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
function charLength(text) { return Array.from(String(text ?? '')).length; }
function clipChars(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  let seen = false;
  for (const value of values) { if (!Number.isFinite(value)) continue; seen = true; if (value < min) min = value; if (value > max) max = value; }
  return seen ? { min, max } : null;
}
function safeJson(value) {
  try { const text = JSON.stringify(value); return typeof text === 'string' ? text : String(value); } catch { return String(value); }
}
function stripJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) return trimmed.slice(3).replace(/```\s*$/, '').trim();
  return trimmed.slice(firstBreak + 1).replace(/```\s*$/, '').trim();
}
function parseJsonObject(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string') { throw new TypeError('curator: 模型返回必须是对象或 JSON 字符串'); }
  const candidates = [raw.trim()];
  const fenced = stripJsonFence(raw);
  if (fenced !== candidates[0]) candidates.push(fenced);
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(raw.slice(open, close + 1));
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch { } }
  throw new Error('curator: 模型返回无法解析为 JSON');
}
function turnNumberOf(value) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : null; }
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
    { role: 'user', content: [...header, '', '对话（每行前缀是该事件的 seq）：', ...blocks].join('\n'), },
  ];
}
function buildSeqTurnMap(turns) {
  const seqTurn = new Map();
  const turnSet = new Set();
  for (const item of turns) {
    turnSet.add(item.turn);
    for (const event of item.events) {
      const seq = turnNumberOf(event?.seq);
      if (seq === null) continue;
      if (!seqTurn.has(seq)) seqTurn.set(seq, item.turn);
    }
  }
  return { seqTurn, turnSet };
}
export function parseSpans(raw, input = {}) {
  const turns = normalizeTurnsInput(input?.turns);
  const { seqTurn, turnSet } = buildSeqTurnMap(turns);
  let parsed;
  try { parsed = parseJsonObject(raw); } catch { return { spans: [], rejected: [{ reason: 'invalid_json', span: null }] }; }
  const list = Array.isArray(parsed) ? parsed : parsed?.spans;
  if (!Array.isArray(list)) { return { spans: [], rejected: [{ reason: 'spans_not_array', span: parsed }] }; }
  const spans = [];
  const rejected = [];
  for (const item of list) {
    if (!isPlainObject(item)) { rejected.push({ reason: 'invalid_span', span: item }); continue; }
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    if (!SPAN_TYPES.includes(type)) { rejected.push({ reason: 'bad_type', span: item }); continue; }
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') { rejected.push({ reason: 'empty_text', span: item }); continue; }
    if (charLength(text) > MAX_SPAN_TEXT) { rejected.push({ reason: 'text_too_long', span: item }); continue; }
    const rawTurns = Array.isArray(item.turns) ? item.turns : [];
    if (rawTurns.length === 0) { rejected.push({ reason: 'turn_not_found', span: item }); continue; }
    const spanTurns = [];
    let turnsOk = true;
    for (const value of rawTurns) {
      const turn = turnNumberOf(value);
      if (turn === null || !turnSet.has(turn)) { turnsOk = false; break; }
      spanTurns.push(turn);
    }
    if (!turnsOk) { rejected.push({ reason: 'turn_not_found', span: item }); continue; }
    const turnNumbers = [...new Set(spanTurns)].sort((a, b) => a - b);
    const evidence = [];
    if (item.evidence !== undefined && item.evidence !== null) {
      if (!Array.isArray(item.evidence)) { rejected.push({ reason: 'bad_evidence', span: item }); continue; }
      const allowedTurns = new Set(turnNumbers);
      const seenSeq = new Set();
      let evidenceOk = true;
      for (const entry of item.evidence) {
        if (!isPlainObject(entry)) { evidenceOk = false; break; }
        const seq = turnNumberOf(entry.seq);
        if (seq === null) { evidenceOk = false; break; }
        const actualTurn = seqTurn.get(seq);
        if (actualTurn === undefined || !allowedTurns.has(actualTurn)) { evidenceOk = false; break; }
        if (seenSeq.has(seq)) continue;
        seenSeq.add(seq);
        evidence.push({ seq, turn: actualTurn });
      }
      if (!evidenceOk) { rejected.push({ reason: 'evidence_not_found', span: item }); continue; }
      evidence.sort((a, b) => a.seq - b.seq);
    }
    const rationaleFrom = RATIONALE_FROM.includes(item.rationale_from)
      ? item.rationale_from
      : null;
    spans.push({ type, text, turns: turnNumbers, evidence, rationale_from: rationaleFrom, });
  }
  spans.sort((a, b) => ( (a.turns[0] ?? 0) - (b.turns[0] ?? 0) || (a.evidence[0]?.seq ?? 0) - (b.evidence[0]?.seq ?? 0) ));
  return { spans, rejected };
}
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
function parseSpanIdList(value) {
  if (Array.isArray(value)) { return value.filter((item) => typeof item === 'string' && item !== ''); }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) { return parsed.filter((item) => typeof item === 'string' && item !== ''); }
    } catch { return [value.trim()]; }
  }
  return [];
}
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
export function parseTopics(raw, input = {}) {
  let parsed;
  try { parsed = parseJsonObject(raw); } catch { return { topics: [], rejected: [{ reason: 'invalid_json', topic: null }] }; }
  const list = Array.isArray(parsed) ? parsed : parsed?.topics;
  if (!Array.isArray(list)) { return { topics: [], rejected: [{ reason: 'topics_not_array', topic: parsed }] }; }
  const newSpans = (Array.isArray(input?.spans) ? input.spans : [])
    .filter((span) => isPlainObject(span) && typeof span.id === 'string' && span.id !== '');
  const newIds = new Set(newSpans.map((span) => span.id));
  const existing = normalizeExistingTopics(input?.existingTopics);
  const existingBySlug = new Map(existing.map((topic) => [topic.slug, topic]));
  const merged = new Map();
  const rejected = [];
  for (const item of list) {
    if (!isPlainObject(item)) { rejected.push({ reason: 'invalid_topic', topic: item }); continue; }
    const slug = typeof item.slug === 'string' ? item.slug.trim().toLowerCase() : '';
    if (!SLUG_RE.test(slug)) { rejected.push({ reason: 'bad_slug', topic: item }); continue; }
    const prior = existingBySlug.get(slug) ?? null;
    const allowed = new Set(newIds);
    if (prior) for (const id of prior.span_ids) allowed.add(id);
    const rawIds = Array.isArray(item.span_ids) ? item.span_ids : [];
    const spanIds = [];
    const seenIds = new Set();
    let droppedIds = 0;
    for (const value of rawIds) {
      const id = typeof value === 'string' ? value.trim() : '';
      if (id === '' || !allowed.has(id)) { droppedIds += 1; continue; }
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      spanIds.push(id);
    }
    if (spanIds.length === 0) { rejected.push({ reason: 'no_span_ids', topic: item, dropped: droppedIds }); continue; }
    if (prior) { for (const id of prior.span_ids) { if (seenIds.has(id)) continue; seenIds.add(id); spanIds.push(id); } }
    let title = typeof item.title === 'string' ? item.title.trim() : '';
    if (title === '') title = prior?.title ?? slug;
    title = clipChars(title, MAX_TOPIC_TITLE);
    let description = typeof item.description === 'string' ? item.description.trim() : '';
    if (description === '') description = prior?.description ?? '';
    description = clipChars(description, MAX_TOPIC_DESCRIPTION);
    const current = merged.get(slug);
    if (current) {
      for (const id of spanIds) { if (!current.span_ids.includes(id)) current.span_ids.push(id); }
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
function resolveEmbedder(embed) {
  if (typeof embed === 'function') { return { available: true, model: null, embed: (texts) => embed(texts) }; }
  if (!isPlainObject(embed)) return null;
  const cfg = isPlainObject(embed.cfg) ? embed.cfg : embed;
  if (cfg.available === false) return null;
  if (typeof embed.embed === 'function') { return { available: true, model: cfg.model ?? null, embed: (texts) => embed.embed(texts) }; }
  if (typeof embed.embedTexts === 'function') {
    return { available: true, model: cfg.model ?? null, embed: (texts) => embed.embedTexts(texts, cfg), };
  }
  if (cfg.available === true) { return { available: true, model: cfg.model ?? null, embed: (texts) => vectorsApi.embedTexts(texts, cfg), }; }
  return null;
}
function toVectorRow(ownerKey, ownerId, model, vector) {
  if (!vector || typeof vector.length !== 'number' || vector.length === 0) return null;
  return { [ownerKey]: ownerId, model: String(model ?? 'unknown'), dim: vector.length, vec: vector, };
}
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
        if (rows.length > 0) { vectorsApi.saveSpanVectors(db, rows); result.spans = rows.length; }
      }
    } catch { }
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
        if (rows.length > 0) { vectorsApi.saveTopicVectors(db, rows); result.topics = rows.length; }
      }
    } catch { }
  }
  return result;
}
function makeSpanId() {
  return `sp_${randomUUID()}`;
}
function resolveInsertedIds(db, batchId, records, insertResult) {
  try {
    const rows = db.prepare('SELECT id FROM spans WHERE batch_id = ? ORDER BY rowid').all(batchId);
    if (Array.isArray(rows) && rows.length === records.length) { return rows.map((row) => row.id); }
  } catch { }
  const returned = Array.isArray(insertResult?.ids) ? insertResult.ids : [];
  if (returned.length === records.length) {
    return returned.map((value) => ( typeof value === 'string' ? value : (value?.id ?? value?.span_id ?? null) ));
  }
  return records.map((record) => record.id);
}
function lookupTopicId(db, scope, slug) {
  try {
    const row = db.prepare('SELECT id FROM topics WHERE scope = ? AND slug = ?').get(scope, slug);
    return row?.id ?? null;
  } catch { return null; }
}
function recordCuration(db, { scope, sessionId, turns, spanCount, topicCount }) {
  try {
    const seqs = [];
    for (const turn of turns) { for (const event of turn.events) { const seq = turnNumberOf(event?.seq); if (seq !== null) seqs.push(seq); } }
    const bounds = minMax(seqs);
    const fromSeq = bounds ? bounds.min : null;
    const toSeq = bounds ? bounds.max : null;
    db.prepare(`
      INSERT INTO curations (id, scope, session_id, from_seq, to_seq, spans, topics, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scope, sessionId ?? null, fromSeq, toSeq, spanCount, topicCount, Date.now());
  } catch { }
}
export async function curateBatch(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') { throw new TypeError('curateBatch: 需要一个 SQLite 数据库实例'); }
  const complete = options.complete;
  if (typeof complete !== 'function') { throw new TypeError('curateBatch: 需要 complete 函数'); }
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
  if (dryRun) { return { ...empty, spans: spans.map((span) => ({ ...span, id: null })), inserted: 0, rejectedSpans: rejected.length, }; }
  if (spans.length === 0) { return { ...empty, rejectedSpans: rejected.length, }; }
  const records = spans.map((span) => ({
    id: makeSpanId(),
    scope,
    type: span.type,
    text: span.text,
    turns: span.turns,
    evidence: span.evidence.map((entry) => ( sessionId ? { session_id: sessionId, seq: entry.seq, turn: entry.turn } : entry )),
    rationale_from: span.rationale_from,
    batch_id: batchId,
    session_ids: sessionId ? [sessionId] : [],
    created_at: Date.now(),
  }));
  if (typeof spansApi.insertSpans !== 'function') { throw new Error('curateBatch: src/core/spans.js 缺少 insertSpans'); }
  const insertResult = spansApi.insertSpans(db, records);
  const insertedCount = Number(insertResult?.inserted);
  const spanIds = resolveInsertedIds(db, batchId, records, insertResult);
  const newSpans = records.map((record, index) => ({ id: spanIds[index], type: record.type, text: record.text, turns: record.turns, }));
  const errors = [];
  let parsedTopics = { topics: [], rejected: [] };
  let existingTopics = [];
  try {
    if (typeof topicsApi.listTopics !== 'function') { throw new Error('src/core/topics.js 缺少 listTopics'); }
    if (typeof topicsApi.upsertTopic !== 'function') { throw new Error('src/core/topics.js 缺少 upsertTopic'); }
    existingTopics = normalizeExistingTopics(topicsApi.listTopics(db, { scope }));
    const topicRaw = await complete(buildTopicMessages({ spans: newSpans, topics: existingTopics }));
    parsedTopics = parseTopics(topicRaw, { spans: newSpans, existingTopics });
  } catch (err) { errors.push(err instanceof Error ? err : new Error(String(err))); }
  const writtenTopics = [];
  for (const topic of parsedTopics.topics) {
    const payload = { scope, slug: topic.slug, title: topic.title, description: topic.description, span_ids: topic.span_ids, };
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
    } catch (err) { errors.push(err instanceof Error ? err : new Error(String(err))); }
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
function collectText(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') { if (value !== '') out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectText(item, out); return; }
  if (typeof value !== 'object') return;
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'reasoning' || type === 'thinking' || type === 'redacted_thinking') return;
  if (type === 'tool-call' || type === 'tool_call' || type === 'tool_use' || type === 'tool-use') { return; }
  if (type === 'tool-result' || type === 'tool_result'
    || type === 'tool-output' || type === 'tool_output') { collectText(value.content ?? value.result ?? value.output, out); return; }
  if (type === 'text') { if (typeof value.text === 'string' && value.text !== '') out.push(value.text); return; }
  if (typeof value.text === 'string' && value.text !== '') { out.push(value.text); return; }
  if (value.content !== undefined) { collectText(value.content, out); return; }
  if (value.message !== undefined) collectText(value.message, out);
}
function contentText(value) { const out = []; collectText(value, out); return out.join('\n'); }
function collectReasoning(value, out) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const item of value) collectReasoning(item, out); return; }
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
  try { const role = attributeOf(event); if (typeof role === 'string' && role !== '') return role; } catch { }
  if (type === 'user/message') return 'user';
  if (type === 'assistant/message') return 'assistant';
  if (type === 'tool/call' || type === 'tool/result') return 'tool';
  return 'system';
}
function normalizeEventForPrompt(event, type) {
  if (!event || typeof event !== 'object') return null;
  if (!SELECTED_EVENT_TYPES.has(type)) return null;
  const seq = turnNumberOf(event?.seq);
  const out = { seq: seq === null ? null : seq, type, role: roleOf(event, type), };
  const data = isPlainObject(event?.data) ? event.data : null;
  if (data) {
    if (type === 'user/message') { out.text = contentText(data.content ?? data.text).trim(); } else if (type === 'assistant/message') {
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
      } else if (type === 'tool/result') { out.output = clipChars(text, MAX_TOOL_OUTPUT); } else { out.text = clipChars(text, MAX_MESSAGE_CHARS); }
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
export function groupTurns(events) {
  const list = Array.isArray(events) ? events : [];
  const hasTurnSignal = list.some((event) => ( event?.type === 'turn/start' || turnNumberOf(event?.data?.turn) !== null ));
  const byTurn = new Map();
  let current = 1;
  let seenTurnStart = false;
  let derivedTurns = 0;
  for (const event of list) {
    const type = typeof event?.type === 'string' ? event.type : '';
    const dataTurn = turnNumberOf(event?.data?.turn);
    if (dataTurn !== null) { current = dataTurn; if (type === 'turn/start') seenTurnStart = true; } else if (type === 'turn/start') {
      if (!seenTurnStart) { seenTurnStart = true; current = 1; } else { current += 1; }
    } else if (!hasTurnSignal) { if (type === 'user/message') { derivedTurns += 1; current = derivedTurns; } }
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
function loadSessionEvents(provided, sessionPath) {
  if (Array.isArray(provided)) return { events: provided, source: 'provided' };
  if (typeof sessionPath === 'string' && sessionPath.trim() !== '') {
    try {
      const parsed = readSessionFile(sessionPath.trim());
      if (Array.isArray(parsed?.events)) { return { events: parsed.events, source: 'session-file' }; }
    } catch { }
  }
  return { events: [], source: 'none' };
}
function toPositiveInt(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback; }
export async function curateSession(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') { throw new TypeError('curateSession: 需要一个 SQLite 数据库实例'); }
  const complete = options.complete;
  if (typeof complete !== 'function') { throw new TypeError('curateSession: 需要 complete 函数'); }
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
  const { events, source } = loadSessionEvents(options.events, options.sessionPath);
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
      if (typeof options.onBatch === 'function') { try { options.onBatch({ index: stats.batches, turns: batchTurns, result }); } catch { } }
    } catch (err) {
      stats.failures += 1;
      stats.errors.push(err instanceof Error ? err : new Error(String(err)));
      if (typeof options.onBatch === 'function') {
        try { options.onBatch({ index: index / turnsPerBatch + 1, turns: batchTurns, error: err }); } catch { }
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
