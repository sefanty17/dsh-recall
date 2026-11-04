import { searchSpans } from './spans.js';
import { normalizeRerankScore, rerankDocuments } from './rerank.js';

/** 重排前多召回一些候选：limit*4 与 40 取大。 */
export const RERANK_CANDIDATE_FACTOR = 4;
export const MIN_RERANK_CANDIDATES = 40;

const DEFAULT_LIMIT = 8;

function normalizeLimit(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

function normalizeThreshold(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function topicText(item) {
  const title = String(item?.title ?? '').trim();
  const description = String(item?.description ?? '').trim();
  return [title, description].filter(Boolean).join('\n') || String(item?.slug ?? '').trim();
}

function topicKey(item, index) {
  const slug = item?.slug;
  if (slug !== undefined && slug !== null && String(slug).trim() !== '') return String(slug);
  const id = item?.id;
  if (id !== undefined && id !== null && String(id).trim() !== '') return String(id);
  return String(index);
}

/**
 * 异步 span 检索：词法 + 向量 → RRF（`searchSpans`，同步）→ 可选重排 → 阈值 → limit。
 *
 * 1) `searchSpans(...)` 用 `max(limit*4, 40)` 多召回、阈值 0；
 * 2) 有重排配置（`cfg.available`）或传了 `rerankFn` 时重排，用重排分替换原分；
 * 3) 重排失败 / 返回空 → 保持原顺序与原分；
 * 4) 阈值过滤在重排之后生效。
 *
 * `searchSpans` 的签名保持不变，这里只是异步包装。
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.scope]
 * @param {number} [opts.limit=8]
 * @param {number} [opts.threshold=0]
 * @param {Float32Array|number[]|null} [opts.queryVec]
 * @param {object|null} [opts.rerankCfg]  resolveRerankConfig() 的结果（或带 available 的同形对象）
 * @param {Function|null} [opts.rerankFn]  测试注入的假重排函数
 * @returns {Promise<Array<{span: object, score: number, reasons: string[]}>>} 分数降序
 */
export async function retrieveSpans(db, {
  query,
  scope,
  limit = DEFAULT_LIMIT,
  threshold = 0,
  queryVec = null,
  rerankCfg = null,
  rerankFn = null,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const maxResults = normalizeLimit(limit);
  const minScore = normalizeThreshold(threshold);
  const candidateLimit = Math.max(maxResults * RERANK_CANDIDATE_FACTOR, MIN_RERANK_CANDIDATES);

  const hits = searchSpans(db, {
    query: q,
    scope,
    limit: candidateLimit,
    threshold: 0,
    queryVec,
  });
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const finish = (list) => list
    .filter((hit) => Number(hit?.score ?? 0) >= minScore)
    .slice(0, maxResults);

  const cfg = rerankCfg !== null && typeof rerankCfg === 'object' ? rerankCfg : null;
  const enabled = typeof rerankFn === 'function' || Boolean(cfg?.available);
  if (!enabled) return finish(hits);

  let scores = null;
  try {
    scores = await rerankDocuments({
      query: q,
      documents: hits.map((hit) => ({
        id: String(hit?.span?.id ?? ''),
        text: String(hit?.span?.text ?? ''),
      })),
      cfg,
      ...(typeof rerankFn === 'function' ? { rerankFn } : {}),
    });
  } catch {
    scores = null;
  }
  if (!Array.isArray(scores) || scores.length === 0) return finish(hits);

  const scoreById = new Map(
    scores.map((item) => [String(item?.id ?? ''), normalizeRerankScore(item?.score)]),
  );
  const merged = hits.map((hit, index) => {
    const rerankScore = scoreById.get(String(hit?.span?.id ?? ''));
    const reranked = Number.isFinite(rerankScore);
    return { hit, index, reranked, score: reranked ? rerankScore : Number(hit?.score ?? 0) };
  });
  merged.sort((a, b) => b.score - a.score || a.index - b.index);

  return merged
    .filter((item) => item.score >= minScore)
    .slice(0, maxResults)
    .map((item) => ({
      ...item.hit,
      score: item.score,
      searchScore: Number(item.hit?.score ?? 0),
      ...(item.reranked
        ? { reasons: [...(Array.isArray(item.hit?.reasons) ? item.hit.reasons : []), `rerank=${item.score.toFixed(3)}`] }
        : {}),
    }));
}

/**
 * 主题候选重排：入参 `[{slug, title, description, ...}]`，返回同结构（浅拷贝）数组，
 * 按重排分降序，并给每项附加 `rerankScore`（0..1），供调用方在重排后过阈值。
 *
 * 没有可用的重排（未配置 / 空问题 / 失败）时按原顺序返回浅拷贝，不附加分数。
 *
 * @param {{question: string, candidates: Array<object>, cfg?: object|null,
 *   rerankFn?: Function|null}} input
 * @returns {Promise<Array<object>>}
 */
export async function rerankTopicCandidates({ question, candidates, cfg = null, rerankFn = null } = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item !== null && typeof item === 'object');
  const copies = list.map((item) => ({ ...item }));
  if (copies.length === 0) return [];
  const q = String(question ?? '').trim();
  if (!q) return copies;
  const config = cfg !== null && typeof cfg === 'object' ? cfg : null;
  const enabled = typeof rerankFn === 'function' || Boolean(config?.available);
  if (!enabled) return copies;

  const documents = copies.map((item, index) => ({
    id: topicKey(item, index),
    text: topicText(item),
  }));
  let scores = null;
  try {
    scores = await rerankDocuments({
      query: q,
      documents,
      cfg: config,
      ...(typeof rerankFn === 'function' ? { rerankFn } : {}),
    });
  } catch {
    scores = null;
  }
  if (!Array.isArray(scores) || scores.length === 0) return copies;

  const scoreById = new Map(
    scores.map((item) => [String(item?.id ?? ''), normalizeRerankScore(item?.score)]),
  );
  const scored = copies.map((item, index) => ({
    item,
    index,
    score: scoreById.get(topicKey(item, index)) ?? 0,
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ item, score }) => ({ ...item, rerankScore: score }));
}

export default { retrieveSpans, rerankTopicCandidates };
