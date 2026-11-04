/**
 * src/plugin/inject.js
 *
 * 每轮注入（v2）：问题 → 主题词法召回 → 主题下 span 概括 + 轮次索引。
 *
 * 两条路径：
 *   buildInjectionSync  —— 同步词法路径：systemPrompt.context 的 text 是同步的
 *                          （DSH 不 await provider 返回值），也是选择器超时后的兜底。
 *   buildInjection      —— 异步选择器路径：给 system-prompt/assemble waterfall
 *                          （经 resolveInjection 包超时 + 缓存）和 memory(action="recall")
 *                          使用；没有模型时自动退回同步词法结果。
 *
 * 输出格式（≤ maxLines 行，默认 200）：
 *   ## 相关记忆（dsh-recall）
 *   ### 主题：TTS 情感与显存
 *   - [decision] 决定情感参数走独立配置文件（第 7 轮）
 *   - [operation] 读 12 个文件定位搜索实现（第 8、9 轮）
 *
 * 容错：两个入口都不抛异常；任何失败返回空结果 / 同步回退。
 */

import { listTopics } from '../core/topics.js';
import { listSpans } from '../core/spans.js';

export const INJECT_HEADER = '## 相关记忆（dsh-recall）';
export const TRUNCATED_NOTE = '…（相关记忆已截断，用 memory(action="recall", question="…") 查看更精确的结果）';

/** 默认最多几个主题（design-v2 第 4 节）。 */
export const DEFAULT_MAX_TOPICS = 8;
/** 无向量时的词法阈值（design-v2 第 4 节 lexicalThreshold）。 */
export const DEFAULT_THRESHOLD = 0.55;
/** 注入内容的安全行数上限（design-v2 第 7 节）。 */
export const DEFAULT_MAX_LINES = 200;
/** 选择器路径的默认超时（waterfall 注入；超时退回同步词法）。 */
export const DEFAULT_SELECTOR_TIMEOUT_MS = 3500;
/** 单条 span 概括的安全字符上限（span.text 本应很短，防止脏数据撑爆上下文）。 */
const MAX_SPAN_CHARS = 500;

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9._-]*/g;
const STOP_CHARS = new Set('的了是在有和与就都也很我你他这那个用哪什么吗呢吧啊呀'.split(''));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipChars(text, limit) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit - 1).join('')}…`;
}

/** 中文 bigram（去重、保序）。 */
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

/** 拉丁词（去重、小写、忽略单字母）。 */
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

function isStopwordGram(gram) {
  return STOP_CHARS.has(gram[0]) && STOP_CHARS.has(gram[1]);
}

/**
 * 问题 → 词项。中文用 bigram、拉丁用整词；停用字组成的 bigram 丢弃。
 * 限制长度，避免超长粘贴把评分变成平方级。
 */
function questionTerms(question) {
  const text = collapse(question).slice(0, 300);
  const grams = cjkBigrams(text).filter((gram) => !isStopwordGram(gram));
  const words = latinTokens(text);
  return { grams, words };
}

/**
 * 主题词法分：query 词项落在 title + description + slug 里的覆盖率。
 * 设计第 4 节的词法代理是 normalized_bm25 * coverage；topics 没有 FTS，
 * 这里用覆盖率作为代理（阈值默认 0.55，与 lexicalThreshold 一致）。
 */
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

function normalizeScope(scope) {
  const text = String(scope ?? '').trim();
  return text === '' ? null : text;
}

/** 本项目主题 + 全局主题（与 facts 的 scope 语义一致）；去重后按更新时间倒序。 */
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
  } else {
    add(listTopics(db, { scope: text }));
    if (text !== 'global') add(listTopics(db, { scope: 'global' }));
  }
  return rows;
}

/** 召回过阈值的主题，最多 maxTopics 个。 */
function rankTopics(db, { scope, question, maxTopics, threshold }) {
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

function normalizeThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_THRESHOLD;
  return Math.min(n, 1);
}

function normalizeMaxLines(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 3) return DEFAULT_MAX_LINES;
  return Math.min(n, 1000);
}

/** Promise 超时（不取消底层任务；选择器接口没有 signal）。 */
function withTimeout(promise, timeoutMs) {
  const ms = Math.floor(Number(timeoutMs));
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`选择器注入超时（${ms}ms）`);
      error.code = 'INJECTION_TIMEOUT';
      reject(error);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 每 turn 的注入结果缓存（LRU，小容量）。
 * key 用 `${sessionId}:${turn}`；新 claim / turn 结束时由调用方按前缀清理。
 */
export function createInjectionCache({ maxEntries = 64 } = {}) {
  const limit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.floor(Number(maxEntries))
    : 64;
  const map = new Map();
  return {
    get size() {
      return map.size;
    },
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      return value;
    },
    deleteByPrefix(prefix) {
      const text = String(prefix ?? '');
      if (!text) return 0;
      let removed = 0;
      for (const key of [...map.keys()]) {
        if (!key.startsWith(text)) continue;
        map.delete(key);
        removed += 1;
      }
      return removed;
    },
    clear() {
      map.clear();
    },
  };
}

function spanTurns(span) {
  const list = Array.isArray(span?.turns) ? span.turns : [];
  const unique = [...new Set(
    list
      .map((turn) => Number(turn))
      .filter((turn) => Number.isFinite(turn))
      .map((turn) => Math.trunc(turn)),
  )];
  unique.sort((a, b) => a - b);
  return unique;
}

function formatTurnSuffix(turns) {
  const list = Array.isArray(turns) ? turns : spanTurns(turns);
  if (list.length === 0) return '（轮次未知）';
  return `（第 ${list.join('、')} 轮）`;
}

/** 同一主题内的 span 按首个轮次升序；没有轮次的排最后。 */
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

function topicTitle(topic) {
  return collapse(topic?.title) || collapse(topic?.slug) || '未命名主题';
}

/**
 * [{ topic, spans }] → 注入文本。所有主题标题 + span 行共用 maxLines 预算，
 * 超了截断并加一行说明（保证总行数 ≤ maxLines）。
 */
function formatBlocks(blocks, maxLines) {
  const limit = normalizeMaxLines(maxLines);
  const entries = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const spans = Array.isArray(block?.spans) ? block.spans : [];
    if (spans.length === 0) continue;
    const slug = String(block.topic?.slug ?? '');
    entries.push({ text: `### 主题：${topicTitle(block.topic)}`, slug });
    for (const span of spans) {
      entries.push({ text: formatSpanLine(span), slug, spanId: String(span?.id ?? '') });
    }
  }
  if (entries.length === 0) {
    return { text: '', topicsUsed: [], spansUsed: [] };
  }

  let kept = entries;
  let truncated = false;
  // 预算 = 标题行 + 内容行（+ 截断说明）
  if (entries.length + 1 > limit) {
    kept = entries.slice(0, Math.max(0, limit - 2));
    truncated = true;
  }

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

/** 按主题的 span_ids 顺序取 span；取不到的 id 静默跳过。 */
function loadTopicSpans(db, topic) {
  const ids = Array.isArray(topic?.span_ids) ? topic.span_ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) return [];
  let rows = [];
  try {
    rows = listSpans(db, { ids });
  } catch {
    return [];
  }
  return sortSpans(rows);
}

// ---------------------------------------------------------------------------
// buildInjectionSync
// ---------------------------------------------------------------------------

/**
 * 同步注入：只做主题词法召回 + 主题下 span 概括，不调选择器模型。
 * systemPrompt.context 的 text 是同步求值的，所以只能走这条。
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} [opts.scope]
 * @param {string} [opts.question] 当前用户问题；为空 → 不注入
 * @param {number} [opts.maxTopics=8]
 * @param {number} [opts.threshold=0.55]
 * @param {number} [opts.maxLines=200]
 * @returns {{text:string, topicsUsed:string[], spansUsed:string[]}}
 */
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
    for (const { topic } of ranked) {
      const spans = loadTopicSpans(db, topic);
      if (spans.length > 0) blocks.push({ topic, spans });
    }
    return formatBlocks(blocks, maxLines);
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// buildInjection（异步，带选择器）
// ---------------------------------------------------------------------------

function rankedCandidates(db, { scope, question, maxTopics, threshold }) {
  return rankTopics(db, { scope, question, maxTopics, threshold });
}

/**
 * 异步注入：主题词法召回 → 选择器（最多打开 4 个主题）→ 选中的 span。
 * 没有 complete（模型）时自动退回 buildInjectionSync 的结果。
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} [opts.scope]
 * @param {string} [opts.question]
 * @param {string[]} [opts.activeTools]
 * @param {(messages:Array<{role:string,content:string}>) => Promise<object|string>} [opts.complete]
 * @param {(slug:string) => Promise<Array<object>>} [opts.openTopic]
 * @param {number} [opts.maxTopics=8]
 * @param {number} [opts.threshold=0.55]
 * @param {number} [opts.maxLines=200]
 * @returns {Promise<{text:string, topicsUsed:string[], spansUsed:string[],
 *   skipped:null|'no-question'|'no-topic'|'no-selector'|'selector-skip'|'error'}>}
 */
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
} = {}) {
  const skipped = (reason, payload = {}) => ({
    text: '',
    topicsUsed: [],
    spansUsed: [],
    ...payload,
    skipped: reason,
  });

  try {
    if (!db || typeof db.prepare !== 'function') return skipped('error');
    const q = collapse(question);
    if (!q) return skipped('no-question');

    const ranked = rankedCandidates(db, { scope, question: q, maxTopics, threshold });
    if (ranked.length === 0) return skipped('no-topic');

    // 没有模型：退回同步词法结果（仍然有用，只是没经过选择器）。
    if (typeof complete !== 'function') {
      const fallback = buildInjectionSync({ db, scope, question: q, maxTopics, threshold, maxLines });
      if (!fallback.text) return skipped('no-topic');
      return { ...fallback, skipped: 'no-selector' };
    }

    let selectSpans;
    try {
      ({ selectSpans } = await import('../core/selector.js'));
    } catch {
      selectSpans = null;
    }
    if (typeof selectSpans !== 'function') {
      const fallback = buildInjectionSync({ db, scope, question: q, maxTopics, threshold, maxLines });
      return fallback.text ? { ...fallback, skipped: 'no-selector' } : skipped('no-topic');
    }

    const topicBySlug = new Map(ranked.map(({ topic }) => [String(topic.slug), topic]));
    const resolveOpenTopic = typeof openTopic === 'function'
      ? async (slug) => {
          const list = await openTopic(slug);
          return Array.isArray(list) ? list : [];
        }
      : async (slug) => {
          const topic = topicBySlug.get(String(slug));
          return topic ? loadTopicSpans(db, topic) : [];
        };

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

    const selectedIds = new Set(
      selected
        .map((item) => (typeof item?.span_id === 'string' ? item.span_id.trim() : ''))
        .filter(Boolean),
    );
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
    // 选择器/DB 的意外错误：尽量给同步词法结果，别让 recall 直接空手而归。
    try {
      const fallback = buildInjectionSync({ db, scope, question, maxTopics, threshold, maxLines });
      if (fallback.text) return { ...fallback, skipped: 'error' };
    } catch {
      // ignore
    }
    return skipped('error');
  }
}

/**
 * waterfall 注入的编排：带超时的选择器 → 超时/异常退回同步词法 → 结果缓存。
 *
 * 这是 `system-prompt/assemble`（async waterfall）里调用的入口：
 *   - 同一 turn 的多次 assemble 命中 cache，不重复跑模型；
 *   - 选择器超时（默认 3500ms）或异常 → buildInjectionSync 兜底；
 *   - 任何情况下都不抛。
 *
 * @param {object} opts 同 buildInjection，另加：
 * @param {number} [opts.timeoutMs=3500]
 * @param {ReturnType<typeof createInjectionCache>} [opts.cache]
 * @param {string} [opts.cacheKey]
 * @returns {Promise<{text:string, topicsUsed:string[], spansUsed:string[],
 *   skipped:null|'no-question'|'no-topic'|'no-selector'|'selector-skip'|'selector-timeout'|'error',
 *   cached?:true}>}
 */
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
} = {}) {
  const key = cache && cacheKey !== null && cacheKey !== undefined ? String(cacheKey) : '';
  if (key) {
    const hit = cache.get(key);
    if (hit !== undefined) return { ...hit, cached: true };
  }
  const remember = (result) => {
    if (key) cache.set(key, result);
    return result;
  };
  const syncFallback = (reason) => {
    try {
      const result = buildInjectionSync({ db, scope, question, maxTopics, threshold, maxLines });
      if (result.text) return { ...result, skipped: reason };
    } catch {
      // 落到下面的空结果
    }
    return { text: '', topicsUsed: [], spansUsed: [], skipped: 'no-topic' };
  };

  let result;
  try {
    result = await withTimeout(
      buildInjection({
        db,
        scope,
        question,
        activeTools,
        complete,
        openTopic,
        maxTopics,
        threshold,
        maxLines,
      }),
      timeoutMs,
    );
  } catch (error) {
    const reason = error?.code === 'INJECTION_TIMEOUT' ? 'selector-timeout' : 'error';
    return remember(syncFallback(reason));
  }

  if (!result || typeof result.text !== 'string') {
    return remember(syncFallback('error'));
  }
  // buildInjection 内部的意外错误已经给过同步回退；没有文本时再兜一次。
  if (!result.text && result.skipped === 'error') {
    return remember(syncFallback('error'));
  }
  return remember(result);
}

export default { buildInjection, buildInjectionSync, resolveInjection, createInjectionCache };
