// inject：每轮注入。同步路径做主题词法召回 + span 概括；异步路径再跑选择器。
// systemPrompt.context 是同步的；system-prompt/assemble 是 async waterfall。
import { listTopics } from '../core/topics.js';
import { listSpans } from '../core/spans.js';
import { rerankTopicCandidates } from '../core/retrieve.js';
export const INJECT_HEADER = '## 相关记忆（dsh-recall）';
export const TRUNCATED_NOTE = '…（相关记忆已截断，用 memory(action="recall", question="…") 查看更精确的结果）';
export const DEFAULT_MAX_TOPICS = 8;
export const DEFAULT_THRESHOLD = 0.55;
export const DEFAULT_MAX_LINES = 200;
export const DEFAULT_SELECTOR_TIMEOUT_MS = 3500;
const MAX_SPAN_CHARS = 500;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9._-]*/g;
const STOP_CHARS = new Set('的了是在有和与就都也很我你他这那个用哪什么吗呢吧啊呀'.split(''));
function collapse(text) { return String(text ?? '') .replace(/\s+/g, ' ') .trim(); }
function clipChars(text, limit) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
}
function cjkBigrams(text) {
  const seen = new Set();
  const out = [];
  for (const run of String(text ?? '').match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const gram = chars[i] + chars[i + 1];
      if (seen.has(gram)) continue;
      seen.add(gram);
      out.push(gram);
    }
  }
  return out;
}
function latinTokens(text) {
  const seen = new Set();
  const out = [];
  for (const word of String(text ?? '').match(LATIN_WORD) ?? []) {
    const lower = word.toLowerCase();
    if (word.length < 2 || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}
function isStopwordGram(gram) { return STOP_CHARS.has(gram[0]) && STOP_CHARS.has(gram[1]); }
function questionTerms(question) {
  const text = collapse(question).slice(0, 300);
  const grams = cjkBigrams(text).filter((gram) => !isStopwordGram(gram));
  const words = latinTokens(text);
  return { grams, words };
}
function topicScore(terms, topic) {
  const total = terms.grams.length + terms.words.length;
  if (total === 0) return 0;
  const hay = collapse(`${topic?.title ?? ''} ${topic?.description ?? ''} ${topic?.slug ?? ''}`).toLowerCase();
  if (!hay) return 0;
  let hits = 0;
  for (const gram of terms.grams) if (hay.includes(gram.toLowerCase())) hits += 1;
  for (const word of terms.words) if (hay.includes(word)) hits += 1;
  return hits / total;
}
function normalizeScope(scope) { const text = String(scope ?? '').trim(); return text === '' ? null : text; }
function topicsForScope(db, scope) {
  const text = normalizeScope(scope);
  const rows = [];
  const seen = new Set();
  const add = (list) => {
    for (const topic of Array.isArray(list) ? list : []) {
      if (!topic || typeof topic.id !== 'string' || seen.has(topic.id)) continue;
      seen.add(topic.id);
      rows.push(topic);
    }
  };
  if (!text) {
    add(listTopics(db, {}));
  } else { add(listTopics(db, { scope: text })); if (text !== 'global') add(listTopics(db, { scope: 'global' })); }
  return rows;
}
export function rankTopics(db, { scope, question, maxTopics, threshold }) {
  const terms = questionTerms(question);
  if (terms.grams.length + terms.words.length === 0) return [];
  const minScore = normalizeThreshold(threshold);
  const limit = normalizeMaxTopics(maxTopics);
  const scored = [];
  for (const topic of topicsForScope(db, scope)) {
    const score = topicScore(terms, topic);
    if (score < minScore) continue;
    scored.push({ topic, score });
  }
  scored.sort((a, b) => (
    b.score - a.score
    || Number(b.topic.updated_at ?? 0) - Number(a.topic.updated_at ?? 0)
    || String(a.topic.slug).localeCompare(String(b.topic.slug))
  ));
  return scored.slice(0, limit);
}
function normalizeMaxTopics(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_TOPICS;
  return Math.min(n, 32);
}
function normalizeThreshold(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD; return Math.min(n, 1); }
function normalizeMaxLines(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 3) return DEFAULT_MAX_LINES;
  return Math.min(n, 1000);
}
function withTimeout(promise, timeoutMs) {
  const ms = Math.floor(Number(timeoutMs));
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`选择器注入超时（${ms}ms）`);
      error.code = 'INJECTION_TIMEOUT';
      reject(error);
    }, ms);
    Promise.resolve(promise).then( (value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }, );
  });
}
export function createInjectionCache({ maxEntries = 64 } = {}) {
  const limit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.floor(Number(maxEntries))
    : 64;
  const map = new Map();
  return {
    get size() { return map.size; },
    get(key) { if (!map.has(key)) return undefined; const value = map.get(key); map.delete(key); map.set(key, value); return value; },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) { const oldest = map.keys().next().value; if (oldest === undefined) break; map.delete(oldest); }
      return value;
    },
    deleteByPrefix(prefix) {
      const text = String(prefix ?? '');
      if (!text) return 0;
      let removed = 0;
      for (const key of [...map.keys()]) { if (!key.startsWith(text)) continue; map.delete(key); removed += 1; }
      return removed;
    },
    clear() { map.clear(); },
  };
}
function spanTurns(span) {
  const list = Array.isArray(span?.turns) ? span.turns : [];
  const unique = [...new Set( list .map((turn) => Number(turn)) .filter((turn) => Number.isFinite(turn)) .map((turn) => Math.trunc(turn)), )];
  unique.sort((a, b) => a - b);
  return unique;
}
function formatTurnSuffix(turns) {
  const list = Array.isArray(turns) ? turns : spanTurns(turns);
  if (list.length === 0) return '（轮次未知）';
  return `（第 ${list.join('、')} 轮）`;
}
function sortSpans(spans) {
  return [...spans].sort((a, b) => {
    const aTurns = spanTurns(a);
    const bTurns = spanTurns(b);
    const aFirst = aTurns.length ? aTurns[0] : Number.MAX_SAFE_INTEGER;
    const bFirst = bTurns.length ? bTurns[0] : Number.MAX_SAFE_INTEGER;
    if (aFirst !== bFirst) return aFirst - bFirst;
    const aCreated = Number(a.created_at ?? 0);
    const bCreated = Number(b.created_at ?? 0);
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a.id).localeCompare(String(b.id));
  });
}
function formatSpanLine(span) {
  const type = collapse(span?.type) || 'span';
  const text = clipChars(collapse(span?.text), MAX_SPAN_CHARS) || '（空）';
  return `- [${type}] ${text}${formatTurnSuffix(spanTurns(span))}`;
}
function topicTitle(topic) { return collapse(topic?.title) || collapse(topic?.slug) || '未命名主题'; }
function formatBlocks(blocks, maxLines) {
  const limit = normalizeMaxLines(maxLines);
  const entries = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const spans = Array.isArray(block?.spans) ? block.spans : [];
    if (spans.length === 0) continue;
    const slug = String(block.topic?.slug ?? '');
    entries.push({ text: `### 主题：${topicTitle(block.topic)}`, slug });
    for (const span of spans) { entries.push({ text: formatSpanLine(span), slug, spanId: String(span?.id ?? '') }); }
  }
  if (entries.length === 0) { return { text: '', topicsUsed: [], spansUsed: [] }; }
  let kept = entries;
  let truncated = false;
  if (entries.length + 1 > limit) { kept = entries.slice(0, Math.max(0, limit - 2)); truncated = true; }
  const lines = [INJECT_HEADER, ...kept.map((entry) => entry.text)];
  if (truncated) lines.push(TRUNCATED_NOTE);
  const topicsUsed = [];
  const spansUsed = [];
  for (const entry of kept) {
    if (entry.slug && !topicsUsed.includes(entry.slug)) topicsUsed.push(entry.slug);
    if (entry.spanId && !spansUsed.includes(entry.spanId)) spansUsed.push(entry.spanId);
  }
  return { text: lines.join('\n'), topicsUsed, spansUsed };
}
function loadTopicSpans(db, topic) {
  const ids = Array.isArray(topic?.span_ids) ? topic.span_ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) return [];
  let rows = [];
  try { rows = listSpans(db, { ids }); } catch { return []; }
  return sortSpans(rows);
}
export function buildInjectionSync({
  db,
  scope,
  question,
  maxTopics = DEFAULT_MAX_TOPICS,
  threshold = DEFAULT_THRESHOLD,
  maxLines = DEFAULT_MAX_LINES,
} = {}) {
  const empty = { text: '', topicsUsed: [], spansUsed: [] };
  try {
    if (!db || typeof db.prepare !== 'function') return empty;
    const q = collapse(question);
    if (!q) return empty;
    const ranked = rankTopics(db, { scope, question: q, maxTopics, threshold });
    if (ranked.length === 0) return empty;
    const blocks = [];
    for (const { topic } of ranked) { const spans = loadTopicSpans(db, topic); if (spans.length > 0) blocks.push({ topic, spans }); }
    return formatBlocks(blocks, maxLines);
  } catch { return empty; }
}
/** 有重排时先召回 maxTopics*3 个候选，再交给 cross-encoder 重排。 */
const RERANK_TOPIC_FACTOR = 3;
const MAX_RERANK_TOPICS = 32;

function buildBlocks(db, ranked) {
  const blocks = [];
  for (const { topic } of ranked) {
    const spans = loadTopicSpans(db, topic);
    if (spans.length > 0) blocks.push({ topic, spans });
  }
  return blocks;
}

/**
 * 重排成功时阈值作用在重排分（0..1）上；重排失败则退回词法分，行为与未开重排一致。
 * 「取 maxTopics → 再过阈值」：先按重排顺序截断，再逐条过滤。
 */
function finalizeRerankedTopics(pool, reranked, { limit, threshold }) {
  const lexicalBySlug = new Map(
    pool.map(({ topic, score }) => [String(topic?.slug ?? ''), score]),
  );
  const items = Array.isArray(reranked) ? reranked : [];
  const hasRerankScores = items.some((item) => Number.isFinite(Number(item?.rerankScore)));
  const minScore = normalizeThreshold(threshold);
  const out = [];
  for (const item of items) {
    const topic = item?.topic && typeof item.topic === 'object' ? item.topic : item;
    if (!topic || typeof topic !== 'object') continue;
    const rerankScore = Number(item?.rerankScore ?? topic?.rerankScore);
    const lexicalScore = lexicalBySlug.get(String(topic?.slug ?? '')) ?? 0;
    const score = hasRerankScores && Number.isFinite(rerankScore) ? rerankScore : lexicalScore;
    if (!Number.isFinite(score) || score < minScore) continue;
    out.push({ topic, score });
    if (out.length >= limit) break;
  }
  return out;
}

async function rankedCandidates(db, {
  scope,
  question,
  maxTopics,
  threshold,
  rerankCfg = null,
  rerankFn = null,
}) {
  const limit = normalizeMaxTopics(maxTopics);
  const cfg = rerankCfg && typeof rerankCfg === 'object' ? rerankCfg : null;
  const canRerank = typeof rerankFn === 'function' || Boolean(cfg?.available);
  if (!canRerank) return rankTopics(db, { scope, question, maxTopics, threshold });
  const poolLimit = Math.min(limit * RERANK_TOPIC_FACTOR, MAX_RERANK_TOPICS);
  // 阈值 0 召回，把「词法不够强但语义相关」的主题也交给重排
  const pool = rankTopics(db, { scope, question, maxTopics: poolLimit, threshold: 0 });
  if (pool.length === 0) return [];
  const candidates = pool.map(({ topic }) => ({ ...topic }));
  const reranked = await rerankTopicCandidates({ question, candidates, cfg, rerankFn });
  return finalizeRerankedTopics(pool, reranked, { limit, threshold });
}
export async function buildInjection({
  db,
  scope,
  question,
  activeTools = [],
  complete,
  openTopic,
  maxTopics = DEFAULT_MAX_TOPICS,
  threshold = DEFAULT_THRESHOLD,
  maxLines = DEFAULT_MAX_LINES,
  rerankCfg = null,
  rerankFn = null,
} = {}) {
  const skipped = (reason, payload = {}) => ({ text: '', topicsUsed: [], spansUsed: [], ...payload, skipped: reason, });
  try {
    if (!db || typeof db.prepare !== 'function') return skipped('error');
    const q = collapse(question);
    if (!q) return skipped('no-question');
    const ranked = await rankedCandidates(db, {
      scope,
      question: q,
      maxTopics,
      threshold,
      rerankCfg,
      rerankFn,
    });
    if (ranked.length === 0) return skipped('no-topic');
    if (typeof complete !== 'function') {
      // 没有选择器模型：直接用（可能已重排的）主题结果拼注入，不再走同步词法重算
      const fallback = formatBlocks(buildBlocks(db, ranked), maxLines);
      if (!fallback.text) return skipped('no-topic');
      return { ...fallback, skipped: 'no-selector' };
    }
    let selectSpans;
    try { ({ selectSpans } = await import('../core/selector.js')); } catch { selectSpans = null; }
    if (typeof selectSpans !== 'function') {
      const fallback = formatBlocks(buildBlocks(db, ranked), maxLines);
      return fallback.text ? { ...fallback, skipped: 'no-selector' } : skipped('no-topic');
    }
    const topicBySlug = new Map(ranked.map(({ topic }) => [String(topic.slug), topic]));
    const resolveOpenTopic = typeof openTopic === 'function'
      ? async (slug) => { const list = await openTopic(slug); return Array.isArray(list) ? list : []; }
      : async (slug) => { const topic = topicBySlug.get(String(slug)); return topic ? loadTopicSpans(db, topic) : []; };
    const result = await selectSpans({
      question: q,
      topics: ranked.map(({ topic }) => ({
        slug: String(topic.slug ?? ''),
        title: String(topic.title ?? ''),
        description: String(topic.description ?? ''),
      })),
      activeTools: Array.isArray(activeTools) ? activeTools : [],
      complete,
      openTopic: resolveOpenTopic,
    });
    const selected = Array.isArray(result?.selected) ? result.selected : [];
    if (selected.length === 0) return skipped('selector-skip');
    const selectedIds = new Set( selected .map((item) => (typeof item?.span_id === 'string' ? item.span_id.trim() : '')) .filter(Boolean), );
    if (selectedIds.size === 0) return skipped('selector-skip');
    const blocks = [];
    for (const { topic } of ranked) {
      const allSpans = loadTopicSpans(db, topic);
      const spans = allSpans.filter((span) => selectedIds.has(String(span.id)));
      if (spans.length > 0) blocks.push({ topic, spans });
    }
    const formatted = formatBlocks(blocks, maxLines);
    if (!formatted.text) return skipped('selector-skip');
    return { ...formatted, skipped: null };
  } catch {
    try {
      const fallback = buildInjectionSync({ db, scope, question, maxTopics, threshold, maxLines });
      if (fallback.text) return { ...fallback, skipped: 'error' };
    } catch { }
    return skipped('error');
  }
}
export async function resolveInjection({
  db,
  scope,
  question,
  activeTools = [],
  complete,
  openTopic,
  maxTopics = DEFAULT_MAX_TOPICS,
  threshold = DEFAULT_THRESHOLD,
  maxLines = DEFAULT_MAX_LINES,
  timeoutMs = DEFAULT_SELECTOR_TIMEOUT_MS,
  cache = null,
  cacheKey = null,
  rerankCfg = null,
  rerankFn = null,
} = {}) {
  const key = cache && cacheKey !== null && cacheKey !== undefined ? String(cacheKey) : '';
  if (key) { const hit = cache.get(key); if (hit !== undefined) return { ...hit, cached: true }; }
  const remember = (result) => { if (key) cache.set(key, result); return result; };
  const syncFallback = (reason) => {
    try {
      const result = buildInjectionSync({ db, scope, question, maxTopics, threshold, maxLines });
      if (result.text) return { ...result, skipped: reason };
    } catch { }
    return { text: '', topicsUsed: [], spansUsed: [], skipped: 'no-topic' };
  };
  let result;
  try {
    result = await withTimeout(
      buildInjection({ db, scope, question, activeTools, complete, openTopic, maxTopics, threshold, maxLines, rerankCfg, rerankFn, }),
      timeoutMs,
    );
  } catch (error) { const reason = error?.code === 'INJECTION_TIMEOUT' ? 'selector-timeout' : 'error'; return remember(syncFallback(reason)); }
  if (!result || typeof result.text !== 'string') { return remember(syncFallback('error')); }
  if (!result.text && result.skipped === 'error') { return remember(syncFallback('error')); }
  return remember(result);
}
export default {
  buildInjection,
  buildInjectionSync,
  resolveInjection,
  createInjectionCache,
  rankTopics,
};
