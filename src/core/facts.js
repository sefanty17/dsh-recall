/**
 * src/core/facts.js
 *
 * 事实状态表：写入（合并 / supersede）、查询、历史、校验标记。
 * 表结构见 docs/design.md 第 3 节（冻结）。
 *
 * 语义：
 *   - 单值键：同 (key, scope) 同时只有一条 active
 *   - 多值键（kind='constraint'、key='never-use'、key='note' 或 value 为 null）：
 *     约束按 (key, value, scope) 去重，同一约束换句话说不重复；
 *     note / value=null 按 (key, value, scope, quote) 去重，不同原文是不同事实
 *   - 同值重复写入 = 「再次确认」：只刷新 verified_at / verified，不新增行
 *   - 不同值（仅单值键）= 新版本：新行 active + supersedes=旧id；旧行 superseded + superseded_by=新id
 *   - 旧行永不删除，factHistory 可回放整条链
 */

import { randomUUID } from 'node:crypto';

const INSERT_FACT_SQL = `
INSERT INTO facts (
  id, key, value, scope, kind, status, since, verified_at, drift, quote, note,
  author, verified, evidence_session, evidence_seq, span_start, span_end,
  supersedes, superseded_by, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** 允许的 drift 取值 */
const DRIFTS = new Set(['stable', 'slow', 'fast']);

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

/** 整数或 null */
function toIntOrNull(value) {
  const n = toEpoch(value);
  return n === null ? null : Math.trunc(n);
}

function toTextOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function selectById(db, id) {
  return db.prepare('SELECT * FROM facts WHERE id = ?').get(id) || null;
}

/**
 * 写入 / 合并一条事实。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} fact
 * @returns {{ fact: object, superseded: string|null }}
 */
export function upsertFact(db, fact) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('upsertFact: 需要一个 SQLite 数据库实例');
  }
  if (!fact || typeof fact !== 'object') {
    throw new TypeError('upsertFact: fact 必须是对象');
  }

  const key = typeof fact.key === 'string' ? fact.key.trim() : '';
  if (!key) throw new TypeError('upsertFact: fact.key 不能为空');

  const scope = fact.scope === null || fact.scope === undefined || fact.scope === ''
    ? 'global'
    : String(fact.scope);
  const value = fact.value === null || fact.value === undefined ? null : String(fact.value);
  const createdAt = toEpoch(fact.created_at) ?? Date.now();
  const kind = typeof fact.kind === 'string' && fact.kind ? fact.kind : 'fact';
  const quote = toTextOrNull(fact.quote);
  // 多值键：约束、never-use、note、以及所有 value 为 null 的事实互不取代。
  // note / value=null 的唯一性键含 quote（不同原文是不同事实）；
  // 约束仍按 value 去重（同一约束换句话说不重复成两条）。
  const quoteScoped = key === 'note' || value === null;
  const multiValue = kind === 'constraint'
    || key === 'never-use'
    || quoteScoped;

  db.exec('SAVEPOINT recall_upsert_fact');
  try {
    let old;
    if (quoteScoped) {
      old = db.prepare(
        "SELECT * FROM facts WHERE key = ? AND scope = ? AND value IS ? AND quote IS ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(key, scope, value, quote);
    } else if (multiValue) {
      old = db.prepare(
        "SELECT * FROM facts WHERE key = ? AND scope = ? AND value IS ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(key, scope, value);
    } else {
      old = db.prepare(
        "SELECT * FROM facts WHERE key = ? AND scope = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      ).get(key, scope);
    }

    if (!old) {
      const inserted = insertFact(db, fact, {
        key,
        scope,
        value,
        createdAt,
        supersedes: multiValue ? null : toTextOrNull(fact.supersedes),
      });
      db.exec('RELEASE recall_upsert_fact');
      return { fact: inserted, superseded: null };
    }

    // 命中旧事实：
    // - 多值键：约束按 value 命中、note 按 value+quote 命中，都只刷新确认时间
    // - 单值键：同值同样只刷新，不产生新版本
    if (multiValue || (old.value === null ? null : String(old.value)) === value) {
      const verifiedAt = toEpoch(fact.verified_at) ?? Date.now();
      const verified = fact.verified === undefined || fact.verified === null
        ? (old.verified ? 1 : 0)
        : (fact.verified ? 1 : 0);
      db.prepare('UPDATE facts SET verified_at = ?, verified = ? WHERE id = ?')
        .run(verifiedAt, verified, old.id);
      const refreshed = selectById(db, old.id);
      db.exec('RELEASE recall_upsert_fact');
      return { fact: refreshed, superseded: null };
    }

    // 单值键不同值：新版本 + 旧版本 superseded
    const inserted = insertFact(db, fact, {
      key,
      scope,
      value,
      createdAt,
      supersedes: old.id,
    });
    db.prepare("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?")
      .run(inserted.id, old.id);
    db.exec('RELEASE recall_upsert_fact');
    return { fact: inserted, superseded: old.id };
  } catch (err) {
    try {
      db.exec('ROLLBACK TO recall_upsert_fact');
      db.exec('RELEASE recall_upsert_fact');
    } catch {
      // 事务已不可回滚时保持原始错误
    }
    throw err;
  }
}

/** 在当前事务内插入一条 active 事实，返回数据库中的行 */
function insertFact(db, fact, normalized) {
  const now = Date.now();
  const verified = fact.verified ? 1 : 0;
  const since = toEpoch(fact.since) ?? normalized.createdAt;
  const verifiedAt = toEpoch(fact.verified_at) ?? (verified ? normalized.createdAt : null);
  const drift = DRIFTS.has(fact.drift) ? fact.drift : 'stable';
  const author = typeof fact.author === 'string' && fact.author ? fact.author : 'rule';
  const kind = typeof fact.kind === 'string' && fact.kind ? fact.kind : 'fact';
  const id = typeof fact.id === 'string' && fact.id ? fact.id : randomUUID();

  db.prepare(INSERT_FACT_SQL).run(
    id,
    normalized.key,
    normalized.value,
    normalized.scope,
    kind,
    'active',
    since,
    verifiedAt,
    drift,
    toTextOrNull(fact.quote),
    toTextOrNull(fact.note),
    author,
    verified,
    toTextOrNull(fact.evidence_session),
    toIntOrNull(fact.evidence_seq),
    toIntOrNull(fact.span_start),
    toIntOrNull(fact.span_end),
    normalized.supersedes ?? null,
    null,
    normalized.createdAt ?? now,
  );

  return selectById(db, id);
}

/**
 * 列出事实。
 * @param {object} [options]
 * @param {string} [options.scope]  省略 = 不限 scope
 * @param {string|'all'|null} [options.status='active']  'all' 或 null = 不限状态
 * @param {string} [options.key]
 */
export function listFacts(db, options = {}) {
  const { scope, status = 'active', key } = options || {};
  const where = [];
  const params = [];

  if (key !== undefined && key !== null && key !== '') {
    where.push('key = ?');
    params.push(String(key));
  }
  if (scope !== undefined && scope !== null && scope !== '') {
    where.push('scope = ?');
    params.push(String(scope));
  }
  if (status !== undefined && status !== null && status !== 'all') {
    where.push('status = ?');
    params.push(String(status));
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM facts ${clause} ORDER BY key ASC, created_at DESC, rowid DESC`,
  ).all(...params);
}

/**
 * 某个 key 的完整版本链（含已废弃），按创建时间升序。
 * @param {object} params
 * @param {string} params.key
 * @param {string} [params.scope] 省略 = 不限 scope
 */
export function factHistory(db, params = {}) {
  const key = params && typeof params.key === 'string' ? params.key.trim() : '';
  if (!key) throw new TypeError('factHistory: key 不能为空');
  const { scope } = params;

  if (scope === undefined || scope === null || scope === '') {
    return db.prepare(
      'SELECT * FROM facts WHERE key = ? ORDER BY created_at ASC, rowid ASC',
    ).all(key);
  }
  return db.prepare(
    'SELECT * FROM facts WHERE key = ? AND scope = ? ORDER BY created_at ASC, rowid ASC',
  ).all(key, String(scope));
}

/**
 * 标记一条事实已被验证（引文与原文逐字一致）。
 * @returns {object|null} 更新后的行；id 不存在时返回 null
 */
export function markVerified(db, id, at) {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('markVerified: id 不能为空');
  }
  const when = toEpoch(at) ?? Date.now();
  const result = db.prepare('UPDATE facts SET verified = 1, verified_at = ? WHERE id = ?')
    .run(when, id);
  if (!result || Number(result.changes) === 0) return null;
  return selectById(db, id);
}

export default { upsertFact, listFacts, factHistory, markVerified };
