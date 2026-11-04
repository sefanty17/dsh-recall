// vectors：embedding 配置 / 文本向量化 / 余弦 / float32 BLOB 存取。
// 默认 backend=none，不联网也能跑；http 与 local 后端按需启用。
import { createRequire } from 'node:module';
const DEFAULT_MODEL = 'bge-small-zh-v1.5';
const LOCAL_MODEL_PREFIX = 'Xenova/';
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const BACKENDS = new Set(['none', 'http', 'local']);
const KNOWN_DIMS = Object.freeze({
  'bge-small-zh-v1.5': 512,
  'BAAI/bge-small-zh-v1.5': 512,
  'Xenova/bge-small-zh-v1.5': 512,
  'bge-base-zh-v1.5': 768,
  'BAAI/bge-base-zh-v1.5': 768,
  'Xenova/bge-base-zh-v1.5': 768,
  'bge-large-zh-v1.5': 1024,
  'BAAI/bge-large-zh-v1.5': 1024,
  'bge-m3': 1024,
  'BAAI/bge-m3': 1024,
});
const localPipelines = new Map();
function localBackendAvailable() {
  try { const require = createRequire(import.meta.url); require.resolve('@huggingface/transformers'); return true; } catch { return false; }
}
function envText(source, key) { const value = source?.[key]; if (value === undefined || value === null) return ''; return String(value).trim(); }
export function resolveEmbeddingConfig(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const rawBackend = envText(source, 'DSH_RECALL_EMBED_BACKEND').toLowerCase();
  const backend = BACKENDS.has(rawBackend) ? rawBackend : 'none';
  const model = envText(source, 'DSH_RECALL_EMBED_MODEL') || DEFAULT_MODEL;
  const url = envText(source, 'DSH_RECALL_EMBED_URL') || null;
  const rawDim = Number(envText(source, 'DSH_RECALL_EMBED_DIM'));
  const explicitDim = Number.isFinite(rawDim) && rawDim > 0 ? Math.floor(rawDim) : null;
  const dim = backend === 'none' ? 0 : explicitDim ?? KNOWN_DIMS[model] ?? null;
  let available = false;
  if (backend === 'http') available = Boolean(url);
  else if (backend === 'local') available = localBackendAvailable();
  return { backend, model, dim, available, url };
}
function normalizeConfig(cfg) {
  const base = resolveEmbeddingConfig();
  const merged = { ...base, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const backend = String(merged.backend ?? 'none').trim().toLowerCase();
  return {
    ...merged,
    backend: BACKENDS.has(backend) ? backend : 'none',
    model: String(merged.model ?? '').trim() || DEFAULT_MODEL,
    url: merged.url ? String(merged.url).trim() : base.url,
  };
}
function endpointOf(url) {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '');
  if (/\/embeddings$/i.test(trimmed)) return trimmed;
  return `${trimmed}/embeddings`;
}
async function embedHttp(list, config) {
  if (!config.url) { throw new Error('http embedding backend requires DSH_RECALL_EMBED_URL'); }
  const key = String( config.apiKey || process.env.DSH_RECALL_EMBED_KEY || process.env.OPENAI_API_KEY || '', ).trim();
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? Math.floor(config.timeoutMs)
    : DEFAULT_HTTP_TIMEOUT_MS;
  let response;
  try {
    response = await fetch(endpointOf(config.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: list }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`embedding request failed: ${err?.message ?? String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`embedding request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const data = Array.isArray(payload?.data) ? [...payload.data] : [];
  if (data.length !== list.length) {
    throw new Error(
      `embedding response size mismatch: expected ${list.length}, got ${data.length}`,
    );
  }
  data.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
  return data.map((item) => Float32Array.from(item?.embedding ?? []));
}
function localModelId(model) {
  const name = String(model ?? '').trim() || DEFAULT_MODEL;
  return name.includes('/') ? name : `${LOCAL_MODEL_PREFIX}${name}`;
}
function getLocalPipeline(model) {
  const modelId = localModelId(model);
  if (localPipelines.has(modelId)) return localPipelines.get(modelId);
  const loading = (async () => {
    let mod;
    try { mod = await import('@huggingface/transformers'); } catch (err) {
      throw new Error('local embedding backend requires @huggingface/transformers', { cause: err, });
    }
    if (typeof mod?.pipeline !== 'function') { throw new Error('local embedding backend requires @huggingface/transformers'); }
    return mod.pipeline('feature-extraction', modelId);
  })();
  loading.catch(() => localPipelines.delete(modelId));
  localPipelines.set(modelId, loading);
  return loading;
}
async function embedLocal(list, config) {
  const extractor = await getLocalPipeline(config.model);
  const output = await extractor(list, { pooling: 'mean', normalize: true });
  let rows;
  if (typeof output?.tolist === 'function') {
    rows = output.tolist();
  } else if (Array.isArray(output)) { rows = output; } else if (output?.data && output?.dims?.length) {
    const width = Number(output.dims[output.dims.length - 1]) || 0;
    rows = [];
    for (let i = 0; i < output.data.length; i += width) { rows.push(Array.from(output.data.slice(i, i + width))); }
  } else { throw new Error('local embedding backend returned an unsupported tensor'); }
  return rows.map((row) => Float32Array.from(row ?? []));
}
export async function embedTexts(texts, cfg = {}) {
  const list = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : [];
  const config = normalizeConfig(cfg);
  if (config.backend === 'none') return null;
  if (!list.length) return [];
  if (config.backend === 'http') return embedHttp(list, config);
  if (config.backend === 'local') return embedLocal(list, config);
  return null;
}
export function cosine(a, b) {
  if (!a || !b) return 0;
  const lengthA = Number(a.length) || 0;
  const lengthB = Number(b.length) || 0;
  if (!lengthA || !lengthB || lengthA !== lengthB) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < lengthA; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, sim));
}
function toFloat32(vec) {
  if (vec instanceof Float32Array) return vec;
  if (Array.isArray(vec) || ArrayBuffer.isView(vec)) return Float32Array.from(vec);
  return new Float32Array(0);
}
function vecToBlob(vec) {
  const floats = toFloat32(vec);
  const buffer = Buffer.allocUnsafe(floats.length * 4);
  for (let i = 0; i < floats.length; i += 1) buffer.writeFloatLE(floats[i], i * 4);
  return buffer;
}
function blobToVec(blob, dim) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
  const capacity = Math.floor(buffer.length / 4);
  const expected = Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : capacity;
  const length = Math.max(0, Math.min(expected, capacity));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
}
function rollback(db, name) {
  try {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
  } catch { }
}
const UPSERT_SPAN_VECTOR = `
INSERT INTO span_vectors (span_id, model, dim, vec) VALUES (?, ?, ?, ?)
ON CONFLICT(span_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec
`;
const UPSERT_TOPIC_VECTOR = `
INSERT INTO topic_vectors (topic_id, model, dim, vec) VALUES (?, ?, ?, ?)
ON CONFLICT(topic_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec
`;
function saveVectors(db, rows, { table, stmtSql, idField }) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const savepoint = `recall_${table}_save`;
  let saved = 0;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const statement = db.prepare(stmtSql);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = row[idField];
      if (typeof id !== 'string' || id.trim() === '') continue;
      const floats = toFloat32(row.vec);
      if (!floats.length) continue;
      statement.run( id, String(row.model ?? 'unknown'), floats.length, vecToBlob(floats), );
      saved += 1;
    }
    db.exec(`RELEASE ${savepoint}`);
    return saved;
  } catch (err) { rollback(db, savepoint); throw err; }
}
export function saveSpanVectors(db, rows) {
  return saveVectors(db, rows, { table: 'span_vectors', stmtSql: UPSERT_SPAN_VECTOR, idField: 'span_id', });
}
export function loadSpanVectors(db, ids) {
  const filtered = Array.isArray(ids);
  if (filtered && ids.length === 0) return [];
  try {
    const sql = filtered
      ? `SELECT span_id, model, dim, vec FROM span_vectors WHERE span_id IN (${ids.map(() => '?').join(',')})`
      : 'SELECT span_id, model, dim, vec FROM span_vectors';
    const params = filtered ? ids.map(String) : [];
    return db.prepare(sql).all(...params).map((row) => ({ span_id: row.span_id, model: row.model, dim: row.dim, vec: blobToVec(row.vec, row.dim), }));
  } catch { return []; }
}
export function saveTopicVectors(db, rows) {
  return saveVectors(db, rows, { table: 'topic_vectors', stmtSql: UPSERT_TOPIC_VECTOR, idField: 'topic_id', });
}
export function loadTopicVectors(db, scope) {
  const hasScope = scope !== undefined && scope !== null && String(scope).trim() !== '';
  try {
    const sql = hasScope
      ? `SELECT v.topic_id, v.model, v.dim, v.vec
         FROM topic_vectors v JOIN topics t ON t.id = v.topic_id
         WHERE t.scope = ?`
      : 'SELECT topic_id, model, dim, vec FROM topic_vectors';
    const rows = hasScope
      ? db.prepare(sql).all(String(scope).trim())
      : db.prepare(sql).all();
    return rows.map((row) => ({ topic_id: row.topic_id, model: row.model, dim: row.dim, vec: blobToVec(row.vec, row.dim), }));
  } catch { return []; }
}
export default { resolveEmbeddingConfig, embedTexts, cosine, saveSpanVectors, loadSpanVectors, saveTopicVectors, loadTopicVectors, };
