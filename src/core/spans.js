// spans：span 的写入、读取与检索（中文 bigram 词法 + 可选向量 RRF）。
// 接口与 DDL 见 docs/design-v2.md 第 2、6 节；searchSpans 是同步函数，向量由调用方预计算。
import { randomUUID } from 'node:crypto';
import { segmentCJK, ftsPhrase } from './chunk.js';
const SPAN_TYPES = new Set(['decision', 'operation', 'narrative']);
const RATIONALE_SOURCES = new Set(['user', 'assistant', 'reasoning', 'tool']);
const DEFAULT_LIMIT = 8;
const CANDIDATE_FACTOR = 4;
const MIN_CANDIDATES = 32;
const MAX_BIGRAMS = 16;
const MAX_LATIN_TOKENS = 8;
const RRF_K = 60;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN_WORD = /[A-Za-z][A-Za-z0-9._-]*/g;
const STOP_CHARS = new Set('的了是在有和与就都也很我你他这那个用哪什么吗呢吧啊呀'.split(''));
function makeSpanId() {
  return `sp_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
function collapse(text) { return String(text ?? '').replace(/\s+/g, ' ').trim(); }
function normalizeBm25(rank) { if (!Number.isFinite(rank)) return 0.5; const magnitude = Math.abs(rank); return magnitude / (1 + magnitude); }
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}
function toIdArray(value) { return toArray(value).map((item) => String(item)).filter((item) => item !== ''); }
function toTurns(value) { return toArray(value) .map((turn) => Number(turn)) .filter((turn) => Number.isInteger(turn)); }
function toEvidence(value) { return toArray(value).filter((item) => item && typeof item === 'object' && !Array.isArray(item)); }
function parseJsonArray(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'string') return toArray(raw);
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function rowToSpan(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    type: row.type,
    text: row.text,
    turns: parseJsonArray(row.turns),
    evidence: parseJsonArray(row.evidence),
    rationale_from: row.rationale_from ?? null,
    batch_id: row.batch_id ?? null,
    session_ids: parseJsonArray(row.session_ids),
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  };
}
function rollback(db, name) {
  try {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
  } catch { }
}
const INSERT_SPAN_SQL = `
INSERT INTO spans (
  id, scope, type, text, turns, evidence, rationale_from, batch_id,
  session_ids, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;
function normalizeSpanInput(span, index, now) {
  if (!span || typeof span !== 'object') {
    throw new TypeError(`insertSpans: 第 ${index + 1} 条不是对象`);
  }
  const text = typeof span.text === 'string' ? span.text.trim() : '';
  if (!text) {
    throw new TypeError(`insertSpans: 第 ${index + 1} 条 text 不能为空`);
  }
  const type = typeof span.type === 'string' ? span.type.trim() : '';
  if (!SPAN_TYPES.has(type)) {
    throw new TypeError(
      `insertSpans: 第 ${index + 1} 条 type 必须是 decision|operation|narrative，收到 ${JSON.stringify(span.type)}`,
    );
  }
  const evidence = toEvidence(span.evidence);
  const declaredSessions = toIdArray(span.session_ids);
  const evidenceSessions = evidence
    .map((item) => (item.session_id === undefined ? '' : String(item.session_id)))
    .filter(Boolean);
  const sessionIds = declaredSessions.length
    ? [...new Set(declaredSessions)]
    : [...new Set(evidenceSessions)];
  const scopeText = span.scope === undefined || span.scope === null ? '' : String(span.scope).trim();
  const rationale = typeof span.rationale_from === 'string' ? span.rationale_from.trim() : '';
  const batchId = typeof span.batch_id === 'string' && span.batch_id.trim() !== ''
    ? span.batch_id.trim()
    : null;
  const createdAt = Number.isFinite(Number(span.created_at)) && span.created_at !== null
    ? Math.trunc(Number(span.created_at))
    : now;
  const providedId = typeof span.id === 'string' ? span.id.trim() : '';
  return {
    id: providedId || makeSpanId(),
    scope: scopeText || 'global',
    type,
    text,
    turnsJson: JSON.stringify(toTurns(span.turns)),
    evidenceJson: JSON.stringify(evidence),
    rationale_from: RATIONALE_SOURCES.has(rationale) ? rationale : null,
    batch_id: batchId,
    sessionIdsJson: JSON.stringify(sessionIds),
    created_at: createdAt,
  };
}
export function insertSpans(db, spans) {
  if (!db || typeof db.prepare !== 'function') { throw new TypeError('insertSpans: 需要一个 SQLite 数据库实例'); }
  const list = Array.isArray(spans) ? spans : spans ? [spans] : [];
  if (list.length === 0) return { inserted: 0, ids: [] };
  const now = Date.now();
  const ids = [];
  db.exec('SAVEPOINT recall_insert_spans');
  try {
    const insertSpan = db.prepare(INSERT_SPAN_SQL);
    const insertFts = db.prepare('INSERT INTO span_fts (search_text, span_id) VALUES (?, ?)');
    for (let i = 0; i < list.length; i += 1) {
      const span = normalizeSpanInput(list[i], i, now);
      insertSpan.run(
        span.id,
        span.scope,
        span.type,
        span.text,
        span.turnsJson,
        span.evidenceJson,
        span.rationale_from,
        span.batch_id,
        span.sessionIdsJson,
        span.created_at,
        null,
      );
      insertFts.run(segmentCJK(span.text), span.id);
      ids.push(span.id);
    }
    db.exec('RELEASE recall_insert_spans');
  } catch (err) { rollback(db, 'recall_insert_spans'); throw err; }
  return { inserted: ids.length, ids };
}
export function listSpans(db, opts = {}) {
  const { scope, ids, limit } = opts ?? {};
  const where = [];
  const params = [];
  if (scope !== undefined && scope !== null && String(scope).trim() !== '') { where.push('scope = ?'); params.push(String(scope).trim()); }
  if (Array.isArray(ids)) {
    if (ids.length === 0) return [];
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids.map(String));
  }
  let sql = 'SELECT * FROM spans';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY created_at ASC, rowid ASC';
  if (Number.isFinite(limit) && limit > 0) { sql += ' LIMIT ?'; params.push(Math.floor(limit)); }
  return db.prepare(sql).all(...params).map(rowToSpan);
}
export function spanById(db, id) {
  if (typeof id !== 'string' || id.trim() === '') return null;
  const row = db.prepare('SELECT * FROM spans WHERE id = ?').get(id.trim());
  return row ? rowToSpan(row) : null;
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
    out.push(word);
    if (out.length >= MAX_LATIN_TOKENS) break;
  }
  return out;
}
function isStopwordGram(gram) { return STOP_CHARS.has(gram[0]) && STOP_CHARS.has(gram[1]); }
function safeFtsPhrase(term) {
  const raw = String(term ?? '').trim();
  if (!raw) return '';
  try { const out = ftsPhrase(raw); if (typeof out === 'string' && out.trim()) return out.trim(); } catch { }
  return `"${raw.replaceAll('"', '""')}"`;
}

function lexicalQueryPlan(query) {
  const attempts = [];
  const phrase = safeFtsPhrase(query);
  if (phrase) attempts.push({ kind: 'phrase', expr: phrase });

  const bigrams = cjkBigrams(query);
  const kept = bigrams.filter((gram) => !isStopwordGram(gram)).slice(0, MAX_BIGRAMS);
  const parts = [ ...latinTokens(query).map((word) => safeFtsPhrase(word)), ...kept.map((gram) => safeFtsPhrase(gram)), ].filter(Boolean);
  const fallbackExpr = [...new Set(parts)].join(' OR ');
  if (fallbackExpr && fallbackExpr !== phrase && !attempts.some((item) => item.expr === fallbackExpr)) {
    attempts.push({ kind: 'bigram', expr: fallbackExpr });
  }
  return { attempts, bigrams };
}

function countBigrams(text, bigrams) {
  if (!bigrams.length) return 0;
  const hay = collapse(text);
  if (!hay) return 0;
  let hit = 0;
  for (const gram of bigrams) if (hay.includes(gram)) hit += 1;
  return hit;
}

function lexicalCandidates(db, query, scope, cap) {
  const { attempts, bigrams } = lexicalQueryPlan(query);
  if (!attempts.length) return { kind: null, items: new Map() };

  let rows = [];
  let matchedKind = null;
  let lastError = null;
  for (const attempt of attempts) {
    const sql = scope
      ? `SELECT s.*, bm25(span_fts) AS rank
         FROM span_fts JOIN spans s ON s.id = span_fts.span_id
         WHERE span_fts MATCH ? AND s.scope = ?
         ORDER BY bm25(span_fts) LIMIT ?`
      : `SELECT s.*, bm25(span_fts) AS rank
         FROM span_fts JOIN spans s ON s.id = span_fts.span_id
         WHERE span_fts MATCH ?
         ORDER BY bm25(span_fts) LIMIT ?`;
    const params = scope ? [attempt.expr, scope, cap] : [attempt.expr, cap];
    try { rows = db.prepare(sql).all(...params); lastError = null; } catch (err) { lastError = err; rows = []; }
    if (rows.length) { matchedKind = attempt.kind; break; }
  }
  if (lastError && rows.length === 0) throw lastError;

  const totalBigrams = bigrams.length;
  const items = new Map();
  for (const row of rows) {
    const span = rowToSpan(row);
    const bm25Norm = normalizeBm25(row.rank);
    const coverage = matchedKind === 'bigram'
      ? (totalBigrams ? countBigrams(span.text, bigrams) / totalBigrams : 1)
      : 1;
    const score = bm25Norm * coverage;
    items.set(span.id, {
      span,
      bm25Norm,
      coverage,
      score,
      reasons: [
        `match=${matchedKind}`,
        `bm25=${bm25Norm.toFixed(3)}`,
        `coverage=${coverage.toFixed(3)}`,
        ...(totalBigrams ? [`bigram:${countBigrams(span.text, bigrams)}/${totalBigrams}`] : []),
      ],
    });
  }
  return { kind: matchedKind, items };
}

// ---------------------------------------------------------------------------
// 向量召回
// ---------------------------------------------------------------------------

/** 取本 scope 下所有已存向量的 span；只用于 hybrid 召回。 */
function loadScopedVectors(db, scope) {
  try {
    const sql = scope
      ? `SELECT v.span_id, v.model, v.dim, v.vec
         FROM span_vectors v JOIN spans s ON s.id = v.span_id
         WHERE s.scope = ?`
      : 'SELECT span_id, model, dim, vec FROM span_vectors';
    const rows = scope ? db.prepare(sql).all(scope) : db.prepare(sql).all();
    return rows;
  } catch { return []; }
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

/**
 * 余弦（与 vectors.js cosine 同语义，但这里避免为了一次检索引入整包逻辑；
 * 行为：长度不等 / 零向量 / 非法值 → 0）。
 */
function cosineSimilarity(a, b) {
  if (!a || !b || !a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

function vectorCandidates(db, queryVec, scope, cap) {
  if (!queryVec || typeof queryVec.length !== 'number' || queryVec.length === 0) return [];
  const rows = loadScopedVectors(db, scope);
  if (!rows.length) return [];
  const scored = [];
  for (const row of rows) {
    const sim = cosineSimilarity(queryVec, blobToVec(row.vec, row.dim));
    if (sim > 0) scored.push({ span_id: row.span_id, cosine: sim });
  }
  scored.sort((a, b) => b.cosine - a.cosine);
  return scored.slice(0, cap);
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/**
 * 检索 span。
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.scope]
 * @param {number} [opts.limit=8]
 * @param {number} [opts.threshold=0]   只保留 score >= threshold 的结果
 * @param {Float32Array|number[]} [opts.queryVec] 预计算的问题向量（走向量召回必需；
 *        同步接口不能自己调 async embedTexts）
 * @returns {Array<{ span: object, score: number, reasons: string[] }>} 分数降序
 */
export function searchSpans(db, opts = {}) {
  const query = String(opts.query ?? '').trim();
  if (!query) return [];

  const scopeText = opts.scope === undefined || opts.scope === null
    ? ''
    : String(opts.scope).trim();
  const scope = scopeText || null;

  const limit = Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.floor(opts.limit)
    : DEFAULT_LIMIT;
  const threshold = Number.isFinite(opts.threshold) ? Number(opts.threshold) : 0;
  const cap = Math.max(limit * CANDIDATE_FACTOR, MIN_CANDIDATES);

  const lexical = lexicalCandidates(db, query, scope, cap);
  const queryVec = opts.queryVec ?? opts.queryVector ?? null;
  const vectors = vectorCandidates(db, queryVec, scope, cap);

  const hasVectors = vectors.length > 0;
  const lexicalItems = lexical.items;

  const lexicalRank = new Map();
  [...lexicalItems.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .forEach(([id], index) => lexicalRank.set(id, index));
  const vectorRank = new Map(vectors.map((item, index) => [item.span_id, index]));
  const cosineById = new Map(vectors.map((item) => [item.span_id, item.cosine]));

  if (!hasVectors) {
    const results = [];
    for (const [id, item] of lexicalItems) { results.push({ span: item.span, score: item.score, reasons: item.reasons }); }
    results.sort((a, b) => b.score - a.score);
    return results
      .filter((item) => item.score >= threshold)
      .slice(0, limit);
  }

  // 混合：RRF（k=60），再按榜首归一化到 1，保证 threshold 语义与纯词法一致。
  const allIds = new Set([...lexicalItems.keys(), ...vectorRank.keys()]);
  const merged = new Map();
  for (const id of allIds) {
    const lexRank = lexicalRank.get(id);
    const vecRank = vectorRank.get(id);
    const rrf = (lexRank === undefined ? 0 : 1 / (RRF_K + lexRank))
      + (vecRank === undefined ? 0 : 1 / (RRF_K + vecRank));
    const lexicalItem = lexicalItems.get(id);
    let span = lexicalItem?.span ?? null;
    if (!span) { const row = db.prepare('SELECT * FROM spans WHERE id = ?').get(id); span = row ? rowToSpan(row) : null; }
    if (!span) continue;
    const cosine = cosineById.get(id);
    merged.set(id, {
      span,
      rrf,
      reasons: [
        ...(lexicalItem?.reasons ?? ['match=vector']),
        `vecRank=${vecRank ?? '-'}`,
        `cosine=${cosine === undefined ? '-' : cosine.toFixed(3)}`,
      ],
    });
  }
  const bestRrf = Math.max(0, ...[...merged.values()].map((item) => item.rrf));
  const results = [...merged.values()].map((item) => ({
    span: item.span,
    score: bestRrf > 0 ? item.rrf / bestRrf : 0,
    reasons: [...item.reasons, `rrf=${item.rrf.toFixed(4)}`],
  }));
  results.sort((a, b) => b.score - a.score);
  return results
    .filter((item) => item.score >= threshold)
    .slice(0, limit);
}

export default { insertSpans, listSpans, searchSpans, spanById };
