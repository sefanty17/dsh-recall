import { createRequire } from 'node:module';

const DEFAULT_LOCAL_MODEL = 'Xenova/bge-reranker-base';
const DEFAULT_HTTP_MODEL = 'BAAI/bge-reranker-v2-m3';
const DEFAULT_TIMEOUT_MS = 8_000;
const LOCAL_BATCH_SIZE = 8;
const BACKENDS = new Set(['none', 'http', 'local']);
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';
const LOCAL_UNAVAILABLE_CODE = 'RERANK_LOCAL_UNAVAILABLE';

/** 已加载的本地 cross-encoder（按模型 id 缓存 Promise，失败后允许重试）。 */
const localRerankers = new Map();

function envText(source, key) {
  const value = source?.[key];
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function defaultModelFor(backend) {
  return backend === 'http' ? DEFAULT_HTTP_MODEL : DEFAULT_LOCAL_MODEL;
}

function normalizeTopN(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeTimeout(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(n, 100), 60_000);
}

function localBackendAvailable() {
  try {
    const require = createRequire(import.meta.url);
    require.resolve(TRANSFORMERS_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

function localUnavailable(cause) {
  const error = new Error(`local rerank backend requires ${TRANSFORMERS_PACKAGE}`);
  error.code = LOCAL_UNAVAILABLE_CODE;
  if (cause) error.cause = cause;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析重排配置（只读环境变量，不发请求、不加载模型）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{backend: 'none'|'http'|'local', model: string, url: string|null,
 *   topN: number, available: boolean}}
 *   `available` 为 false 时调用方应跳过重排：none / http 缺 url 或缺 key / local 没装包。
 */
export function resolveRerankConfig(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const rawBackend = envText(source, 'DSH_RECALL_RERANK_BACKEND').toLowerCase();
  const backend = BACKENDS.has(rawBackend) ? rawBackend : 'none';
  const model = envText(source, 'DSH_RECALL_RERANK_MODEL') || defaultModelFor(backend);
  const url = envText(source, 'DSH_RECALL_RERANK_URL') || null;
  const topN = normalizeTopN(envText(source, 'DSH_RECALL_RERANK_TOP_N'));
  const key = envText(source, 'DSH_RECALL_RERANK_KEY') || envText(source, 'OPENAI_API_KEY');

  let available = false;
  if (backend === 'http') available = Boolean(url) && Boolean(key);
  else if (backend === 'local') available = localBackendAvailable();

  return { backend, model, url, topN, available };
}

/**
 * 合并调用方传入的配置与环境变量；返回的 `available` 按合并后的值重算。
 * 注意：返回值里不带 key（key 只在发请求时从 cfg.apiKey / process.env 现取）。
 */
function normalizeRerankConfig(cfg) {
  const source = isPlainObject(cfg) ? cfg : {};
  const rawBackend = String(
    source.backend ?? envText(process.env, 'DSH_RECALL_RERANK_BACKEND'),
  ).trim().toLowerCase();
  const backend = BACKENDS.has(rawBackend) ? rawBackend : 'none';
  const model = String(source.model ?? '').trim()
    || envText(process.env, 'DSH_RECALL_RERANK_MODEL')
    || defaultModelFor(backend);
  const url = (String(source.url ?? '').trim()
    || envText(process.env, 'DSH_RECALL_RERANK_URL')) || null;
  const topN = normalizeTopN(source.topN ?? envText(process.env, 'DSH_RECALL_RERANK_TOP_N'));
  const timeoutMs = normalizeTimeout(source.timeoutMs);
  const apiKey = String(source.apiKey ?? '').trim();
  return { backend, model, url, topN, timeoutMs, apiKey };
}

/**
 * 把后端的原始分归一化到 0..1：已经在 0..1 的值原样透传，其余走 sigmoid。
 * 非数值（NaN / undefined / null）→ 0。
 */
export function normalizeRerankScore(raw) {
  const value = typeof raw === 'string' ? Number(raw.trim() === '' ? Number.NaN : raw) : Number(raw);
  if (!Number.isFinite(value)) return 0;
  if (value >= 0 && value <= 1) return value;
  const sigmoid = 1 / (1 + Math.exp(-value));
  return Math.min(1, Math.max(0, sigmoid));
}

function endpointOf(url) {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '');
  if (/\/rerank$/i.test(trimmed)) return trimmed;
  return `${trimmed}/rerank`;
}

function apiKeyOf(config) {
  return String(
    config?.apiKey
      || process.env.DSH_RECALL_RERANK_KEY
      || process.env.OPENAI_API_KEY
      || '',
  ).trim();
}

function rawResultsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function rerankHttp({ query, documents, config }) {
  if (!config.url) {
    throw new Error('http rerank backend requires DSH_RECALL_RERANK_URL');
  }
  const headers = { 'content-type': 'application/json' };
  const key = apiKeyOf(config);
  if (key) headers.authorization = `Bearer ${key}`;
  const topN = config.topN > 0 ? Math.min(config.topN, documents.length) : documents.length;
  let response;
  try {
    response = await fetch(endpointOf(config.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        query,
        documents: documents.map((doc) => doc.text),
        top_n: topN,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    // 只保留原因，不把 header / key 带进错误
    throw new Error(`rerank request failed: ${error?.message ?? String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`rerank request failed: HTTP ${response.status}`);
  }
  return rawResultsOf(await response.json());
}

function tensorRows(value) {
  if (!value) return [];
  if (typeof value.tolist === 'function') {
    try {
      const list = value.tolist();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  const dims = Array.isArray(value?.dims) ? value.dims.map(Number) : [];
  const data = value?.data;
  if (!dims.length || (!Array.isArray(data) && !ArrayBuffer.isView(data))) return [];
  if (dims.length === 1) return Array.from(data);
  const width = dims[dims.length - 1] || 1;
  const rows = [];
  for (let i = 0; i + width <= data.length; i += width) {
    rows.push(Array.from(data.slice(i, i + width)));
  }
  return rows;
}

/** 单标签 cross-encoder 取回归分；多标签模型退化为最后一类的 softmax 概率。 */
function scoreFromLogits(row) {
  if (typeof row === 'number') return row;
  if (!Array.isArray(row) || row.length === 0) return Number.NaN;
  if (row.length === 1) return Number(row[0]);
  const values = row.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return Number.NaN;
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const sum = exps.reduce((total, value) => total + value, 0);
  return sum > 0 ? exps[exps.length - 1] / sum : Number.NaN;
}

function localModelId(model) {
  const name = String(model ?? '').trim() || DEFAULT_LOCAL_MODEL;
  return name.includes('/') ? name : `Xenova/${name}`;
}

function getLocalReranker(model) {
  const modelId = localModelId(model);
  const cached = localRerankers.get(modelId);
  if (cached) return cached;
  const loading = (async () => {
    let mod;
    try {
      mod = await import(TRANSFORMERS_PACKAGE);
    } catch (error) {
      throw localUnavailable(error);
    }
    const tokenizerFactory = mod?.AutoTokenizer;
    const modelFactory = mod?.AutoModelForSequenceClassification;
    if (typeof tokenizerFactory?.from_pretrained !== 'function'
      || typeof modelFactory?.from_pretrained !== 'function') {
      throw localUnavailable();
    }
    const [tokenizer, classifier] = await Promise.all([
      tokenizerFactory.from_pretrained(modelId),
      modelFactory.from_pretrained(modelId),
    ]);
    return { tokenizer, model: classifier };
  })();
  loading.catch(() => localRerankers.delete(modelId));
  localRerankers.set(modelId, loading);
  return loading;
}

async function rerankLocal({ query, documents, config }) {
  const { tokenizer, model } = await getLocalReranker(config.model);
  const scores = [];
  for (let start = 0; start < documents.length; start += LOCAL_BATCH_SIZE) {
    const batch = documents.slice(start, start + LOCAL_BATCH_SIZE);
    const inputs = tokenizer(
      batch.map(() => query),
      batch.map((doc) => doc.text),
      { padding: true, truncation: true },
    );
    const output = await model(inputs);
    const rows = tensorRows(output?.logits ?? output);
    if (rows.length !== batch.length) {
      throw new Error('local rerank backend returned unexpected logits');
    }
    for (let i = 0; i < batch.length; i += 1) {
      scores.push({ id: batch[i].id, score: normalizeRerankScore(scoreFromLogits(rows[i])) });
    }
  }
  return scores;
}

function normalizeDocuments(documents) {
  const list = Array.isArray(documents) ? documents : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = item.id === undefined || item.id === null ? '' : String(item.id);
    if (!id) continue;
    out.push({ id, text: String(item.text ?? '') });
  }
  return out;
}

/**
 * 把后端（或注入的 rerankFn）的返回值摊平成 [{id, score}]：
 * - 数组项可以是 `{id, score}`，也可以是 `{index, score}`；
 * - 后端可能只返回 top_n 条，缺失的文档记 0 分，保证每个输入都有分数。
 */
function collectScores(documents, raw) {
  const byId = new Map();
  const add = (id, score) => {
    const key = String(id ?? '');
    if (!key) return;
    const value = normalizeRerankScore(score);
    const previous = byId.get(key);
    if (previous === undefined || value > previous) byId.set(key, value);
  };
  for (const item of rawResultsOf(raw)) {
    if (!item || typeof item !== 'object') continue;
    if (item.id !== undefined && item.id !== null) {
      add(item.id, item.score ?? item.relevance_score);
      continue;
    }
    const index = Number(item.index);
    if (Number.isInteger(index) && index >= 0 && index < documents.length) {
      add(documents[index].id, item.score ?? item.relevance_score);
    }
  }
  return documents.map((doc, index) => ({
    id: doc.id,
    score: byId.get(doc.id) ?? 0,
    index,
  }));
}

function applyTopN(scored, topN) {
  const list = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  const limit = normalizeTopN(topN);
  return (limit > 0 ? list.slice(0, limit) : list).map(({ id, score }) => ({ id, score }));
}

/**
 * 对 `[{id, text}]` 重排，返回按分数降序的 `[{id, score}]`（score ∈ 0..1）。
 *
 * - `cfg.available === false` / `backend === 'none'` / 空 query → null（调用方退回原顺序）
 * - HTTP 失败、超时 → null（不抛）
 * - local 没装 `@huggingface/transformers` → 抛明确错误（配置性问题，不吞）
 * - 传了 `rerankFn` 时用它替代真实后端（测试注入点）
 *
 * @param {{query: string, documents: Array<{id: string, text: string}>, cfg?: object,
 *   rerankFn?: Function}} input
 * @returns {Promise<Array<{id: string, score: number}>|null>}
 */
export async function rerankDocuments({ query, documents, cfg = null, rerankFn = null } = {}) {
  const q = String(query ?? '').trim();
  const docs = normalizeDocuments(documents);
  if (docs.length === 0) return [];
  if (!q) return null;
  const config = normalizeRerankConfig(cfg);

  let scored;
  try {
    if (typeof rerankFn === 'function') {
      scored = collectScores(docs, await rerankFn({ query: q, documents: docs, cfg: config }));
    } else if (config.backend === 'none') {
      return null;
    } else if (config.backend === 'http') {
      scored = collectScores(docs, await rerankHttp({ query: q, documents: docs, config }));
    } else {
      scored = collectScores(docs, await rerankLocal({ query: q, documents: docs, config }));
    }
  } catch (error) {
    if (error?.code === LOCAL_UNAVAILABLE_CODE) throw error;
    return null;
  }
  return applyTopN(scored, config.topN);
}

export default {
  resolveRerankConfig,
  rerankDocuments,
  normalizeRerankScore,
};
