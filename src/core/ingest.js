/**
 * src/core/ingest.js
 *
 * 会话日志 -> 索引（events / units / unit_fts）。
 *
 * 接口（docs/design.md 第 4 节，冻结）：
 *   computeSurfaces(events)               -> Map<seq, 'current'|'shadowed'|'log-only'>
 *   ingestSession(db, { header, events }) -> { units, facts, events }
 *   ingestAll(db, sessionsRoot, { onProgress })
 *   extractFacts(db, { header, events })  -> { facts }（规则抽取写 facts 表）
 *
 * 原则：原文只读；索引是派生品，一个 session 的索引整段删除后全量重灌。
 */

import { chunkText, attributeOf, segmentCJK } from './chunk.js';
import { listSessionFiles, readSessionFile } from './reader.js';
import { scanText } from './rules.js';
import { upsertFact } from './facts.js';

/** 会产生 unit 的事件类型 */
const UNIT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
]);

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

/** 取事件 seq，缺失时退回 1-based 下标 */
function seqOf(event, index) {
  const n = Number(event?.seq);
  return Number.isFinite(n) ? Math.trunc(n) : index + 1;
}

/** JSON.stringify 的安全版本 */
function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * 递归收集 content 里可索引的文本（真实 DSH 日志有两层嵌套）：
 *   - 字符串 / 字符串数组直接拼
 *   - { type: 'text', text } -> text
 *   - { type: 'reasoning' | 'thinking' } -> 跳过
 *   - { type: 'tool-call', name, arguments } -> 「工具名 + 参数」
 *   - { type: 'tool-result', content: [...] } -> 递归进 content
 */
function collectText(value, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value !== '') out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const part of value) collectText(part, out);
    return;
  }
  if (typeof value !== 'object') return;

  const type = typeof value.type === 'string' ? value.type : '';

  // 思考过程不进索引
  if (type === 'reasoning' || type === 'thinking' || type === 'redacted_thinking') return;

  if (type === 'text') {
    if (typeof value.text === 'string' && value.text !== '') out.push(value.text);
    return;
  }

  // assistant 消息里的工具调用块
  if (type === 'tool-call' || type === 'tool_call' || type === 'tool_use' || type === 'tool-use') {
    const name = typeof value.name === 'string'
      ? value.name
      : (typeof value.toolName === 'string' ? value.toolName : '');
    const args = value.arguments ?? value.args ?? value.input ?? {};
    const argsText = typeof args === 'string' ? args : safeJson(args);
    const line = [name, argsText].filter(Boolean).join(' ');
    if (line) out.push(line);
    return;
  }

  // tool/result 里的嵌套结果块
  if (type === 'tool-result' || type === 'tool_result'
    || type === 'tool-output' || type === 'tool_output') {
    collectText(value.content ?? value.result ?? value.output, out);
    return;
  }

  if (typeof value.text === 'string') {
    if (value.text !== '') out.push(value.text);
    return;
  }
  if (value.content !== undefined) {
    collectText(value.content, out);
    return;
  }
  if (value.message !== undefined) collectText(value.message, out);
}

/** 从 content（字符串 / parts 数组 / 嵌套对象）里取纯文本 */
function contentText(value) {
  const out = [];
  collectText(value, out);
  return out.join('\n');
}

/** 各事件类型的入库文本上限（user/message 不截断） */
const TEXT_LIMITS = {
  'assistant/message': 6000,
  'tool/result': 2000,
  'tool/call': 2000,
};

/** 截断标记（计入 events.text / units） */
const TRUNCATED_MARK = '…[truncated]';

/**
 * 按事件类型截断文本。
 * 截断发生在 chunkText 之前，因此 events.text、unit.start/end、unit.text
 * 永远基于同一份截断后文本，slice 一致性不受影响。
 */
function truncateText(text, type) {
  const limit = TEXT_LIMITS[type];
  if (!Number.isFinite(limit) || text.length <= limit) return text;
  return text.slice(0, limit) + TRUNCATED_MARK;
}

/**
 * 从事件里抽可索引的文本（已按类型截断）。
 * 只对 UNIT_TYPES 生成内容，其他类型返回 ''。
 */
function extractEventText(event) {
  const type = event?.type;
  if (!UNIT_TYPES.has(type)) return '';
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const raw = rawEventText(type, data);
  if (!raw) return '';
  return truncateText(raw, type);
}

/** 抽取未截断的原始文本 */
function rawEventText(type, data) {
  if (type === 'user/message') {
    const content = contentText(data.content);
    if (content) return content;
    return typeof data.text === 'string' ? data.text : '';
  }

  if (type === 'assistant/message') {
    const content = contentText(data.message ?? data.content);
    if (content) return content;
    const alt = data.text;
    return typeof alt === 'string' ? alt : '';
  }

  if (type === 'tool/call') {
    const name = typeof data.name === 'string' ? data.name : '';
    const args = data.arguments ?? data.args ?? {};
    const argsText = typeof args === 'string' ? args : safeJson(args);
    return [name, argsText].filter(Boolean).join(' ').trim();
  }

  if (type === 'tool/result') {
    const parts = [];
    // 真实 DSH 日志：data.message.content[]，其中还有一层 type='tool-result' 的嵌套块
    const body = contentText(data.message ?? data.content ?? data.result ?? data.text);
    if (body) parts.push(body);
    const errorName = data.error?.name ?? data.result?.error?.name;
    const errorCode = data.error?.code ?? data.result?.error?.code;
    if (errorName) parts.push(String(errorName));
    if (errorCode) parts.push(String(errorCode));
    return parts.join(' ').trim();
  }

  return '';
}

/**
 * 计算每条事件的可见性。
 * - surfaceOp.op === 'replace' 的事件，把 startSeq..endSeq 区间内的事件标记为 shadowed
 * - 剩下的里，surfaceOp 有值（'append' 或对象）的是 current
 * - 其余是 log-only
 * @param {object[]} events
 * @returns {Map<number, 'current'|'shadowed'|'log-only'>}
 */
export function computeSurfaces(events) {
  const list = Array.isArray(events) ? events : [];
  const seqs = list.map((event, index) => seqOf(event, index));
  const shadowed = new Set();

  for (const event of list) {
    const op = event?.surfaceOp;
    if (!op || typeof op !== 'object' || op.op !== 'replace') continue;

    const rawStart = op.startSeq ?? op.start ?? event.startSeq ?? event.start;
    const rawEnd = op.endSeq ?? op.end ?? event.endSeq ?? event.end;
    const a = Number(rawStart);
    const b = Number(rawEnd);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (const seq of seqs) {
      if (seq >= lo && seq <= hi) shadowed.add(seq);
    }
  }

  const surfaces = new Map();
  list.forEach((event, index) => {
    const seq = seqs[index];
    if (shadowed.has(seq)) surfaces.set(seq, 'shadowed');
    else if (event?.surfaceOp) surfaces.set(seq, 'current');
    else surfaces.set(seq, 'log-only');
  });
  return surfaces;
}

/** 只抽用户真的说的话：source.kind 缺失或为 'user'；plugin / agent-instructions 等注入一律跳过 */
function isUserAuthored(event) {
  const kind = event?.data?.source?.kind;
  return kind === undefined || kind === null || kind === 'user';
}

/**
 * 从用户消息里抽事实，写入 facts 表（规则抽取的唯一接线点）。
 * - 只扫 user/message，且 source.kind 必须是 user 或缺失
 * - shadowed 的消息照样抽：压缩只是显示折叠，原文仍在，事实不会因此失效
 * - 幂等：同 (key, scope, value, evidence_session, evidence_seq) 已存在直接跳过
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ header: object, events: object[] }} session
 * @returns {{ facts: number }} 本次新插入的事实条数
 */
export function extractFacts(db, session) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('extractFacts: 需要一个 SQLite 数据库实例');
  }
  const header = session?.header && typeof session.header === 'object' ? session.header : {};
  const events = Array.isArray(session?.events) ? session.events : [];

  // 子代理会话会重放父会话的上下文，只从根会话抽事实（units 照常入库，检索仍可用）
  const delegationDepth = Number(header.delegationDepth ?? 0);
  if ((Number.isFinite(delegationDepth) && delegationDepth > 0)
    || header.origin === 'subagent') {
    return { facts: 0 };
  }

  const sessionIdRaw = header.id ?? header.sessionId ?? header.session_id;
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) throw new Error('extractFacts: header.id 缺失');

  const scope = typeof header.cwd === 'string' && header.cwd !== ''
    ? header.cwd
    : (typeof header.workdir === 'string' && header.workdir !== '' ? header.workdir : 'global');

  const existsStmt = db.prepare(`
    SELECT id FROM facts
    WHERE key = ? AND scope = ? AND value IS ? AND evidence_session = ? AND evidence_seq = ?
    LIMIT 1
  `);
  // 内容去重：同 (key, value, scope) 且 quote 相同的证据只保留最早一条
  const duplicateStmt = db.prepare(`
    SELECT id, since FROM facts
    WHERE key = ? AND scope = ? AND value IS ? AND quote = ?
    ORDER BY COALESCE(since, created_at) ASC, created_at ASC, rowid ASC
    LIMIT 1
  `);
  const refreshDuplicate = db.prepare('UPDATE facts SET verified_at = ? WHERE id = ?');
  const moveDuplicateEvidence = db.prepare(`
    UPDATE facts
    SET since = ?, evidence_session = ?, evidence_seq = ?,
        span_start = ?, span_end = ?, verified_at = ?
    WHERE id = ?
  `);
  const activeValueStmt = db.prepare(`
    SELECT id FROM facts
    WHERE key = ? AND scope = ? AND value IS ? AND status = 'active'
    LIMIT 1
  `);

  let inserted = 0;
  db.exec('SAVEPOINT recall_extract_facts');
  try {
    events.forEach((event, index) => {
      if (event?.type !== 'user/message') return;
      if (!isUserAuthored(event)) return;
      const seq = seqOf(event, index);
      const time = toEpoch(event?.time ?? event?.timestamp ?? event?.at);
      const text = extractEventText(event);
      if (!text || !text.trim()) return;

      for (const candidate of scanText(text, { time, author: 'user', scope })) {
        const value = candidate.value;
        if (existsStmt.get(candidate.keyHint, scope, value, sessionId, seq)) continue;

        // 同 quote 的同一事实（父/子会话重放、重复粘贴）只留最早一条
        const duplicate = duplicateStmt.get(candidate.keyHint, scope, value, candidate.quote);
        if (duplicate) {
          const verifiedAt = Date.now();
          if (time !== null && (duplicate.since === null || time < duplicate.since)) {
            // 新证据更早：把证据位迁到更早的一次，仍然只保留一行
            moveDuplicateEvidence.run(
              time,
              sessionId,
              seq,
              candidate.evidence.start,
              candidate.evidence.end,
              verifiedAt,
              duplicate.id,
            );
          } else {
            refreshDuplicate.run(verifiedAt, duplicate.id);
          }
          continue;
        }

        const alreadyActive = activeValueStmt.get(candidate.keyHint, scope, value);

        upsertFact(db, {
          key: candidate.keyHint,
          value,
          scope,
          kind: candidate.kind,
          drift: candidate.drift,
          quote: candidate.quote,
          since: time,
          author: 'user',
          verified: 1,
          evidence_session: sessionId,
          evidence_seq: seq,
          span_start: candidate.evidence.start,
          span_end: candidate.evidence.end,
        });
        if (!alreadyActive) inserted += 1;
      }
    });
    db.exec('RELEASE recall_extract_facts');
  } catch (err) {
    try {
      db.exec('ROLLBACK TO recall_extract_facts');
      db.exec('RELEASE recall_extract_facts');
    } catch {
      // 保持原始错误
    }
    throw err;
  }

  return { facts: inserted };
}

/**
 * 写入一个会话。event_count 相同视为已入库，直接返回（幂等）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ header: object, events: object[] }} session
 * @returns {{ units: number, facts: number, events: number }}
 */
export function ingestSession(db, session) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('ingestSession: 需要一个 SQLite 数据库实例');
  }

  const header = session?.header && typeof session.header === 'object' ? session.header : {};
  const events = Array.isArray(session?.events) ? session.events : [];

  const sessionIdRaw = header.id ?? header.sessionId ?? header.session_id;
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) throw new Error('ingestSession: header.id 缺失');

  const existing = db.prepare('SELECT event_count FROM sessions WHERE id = ?').get(sessionId);
  if (existing && Number(existing.event_count) === events.length) {
    return { units: 0, facts: 0, events: 0 };
  }

  const now = Date.now();
  const surfaces = computeSurfaces(events);
  const firstEventTime = events.reduce((acc, event) => {
    if (acc !== null) return acc;
    return toEpoch(event?.time ?? event?.timestamp ?? event?.at);
  }, null);
  const createdAt = toEpoch(header.createdAt ?? header.created_at ?? header.time) ?? firstEventTime;
  const cwd = header.cwd ?? header.workdir ?? header.cwdPath ?? null;
  const parentId = header.parentId ?? header.parent_id ?? header.parentSession ?? null;
  const origin = header.origin ?? null;
  const path = header.path ?? null;

  db.exec('SAVEPOINT recall_ingest_session');
  try {
    // 该 session 的旧索引整段清掉（FTS 先删，再删 units 本体）
    db.prepare(
      'DELETE FROM unit_fts WHERE unit_id IN (SELECT id FROM units WHERE session_id = ?)',
    ).run(sessionId);
    db.prepare('DELETE FROM units WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);

    db.prepare(`
      INSERT INTO sessions (id, path, cwd, created_at, parent_id, origin, event_count, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = COALESCE(excluded.path, sessions.path),
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        parent_id = excluded.parent_id,
        origin = excluded.origin,
        event_count = excluded.event_count,
        ingested_at = excluded.ingested_at
    `).run(sessionId, path, cwd, createdAt, parentId, origin, events.length, now);

    const insertEvent = db.prepare(`
      INSERT OR REPLACE INTO events (session_id, seq, type, time, surface, author, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertUnit = db.prepare(`
      INSERT INTO units (session_id, seq, start, end, text, time, author, surface)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare('INSERT INTO unit_fts (search_text, unit_id) VALUES (?, ?)');

    let unitCount = 0;

    events.forEach((event, index) => {
      const seq = seqOf(event, index);
      const type = typeof event?.type === 'string' && event.type ? event.type : 'unknown';
      const time = toEpoch(event?.time ?? event?.timestamp ?? event?.at);
      const surface = surfaces.get(seq) ?? null;

      let author = null;
      try {
        author = attributeOf(event) ?? null;
      } catch {
        author = null;
      }

      const text = extractEventText(event);
      insertEvent.run(sessionId, seq, type, time, surface, author, text || null);

      if (!text || !text.trim()) return;

      const chunks = chunkText(text);
      if (!Array.isArray(chunks)) return;

      for (const chunk of chunks) {
        const chunkValue = typeof chunk?.text === 'string' ? chunk.text : '';
        if (!chunkValue.trim()) continue;

        const start = Number.isInteger(chunk?.start) ? chunk.start : 0;
        const end = Number.isInteger(chunk?.end) ? chunk.end : chunkValue.length - 1;
        // search_text 只进 FTS，units 不再存第二份
        const searchText = segmentCJK(chunkValue);

        const info = insertUnit.run(
          sessionId,
          seq,
          start,
          end,
          chunkValue,
          time,
          author,
          surface,
        );
        insertFts.run(searchText, info.lastInsertRowid);
        unitCount += 1;
      }
    });

    // 规则抽取：units 落库后，把用户消息里的候选事实写入 facts 表
    const factStats = extractFacts(db, { header: { ...header, id: sessionId, cwd }, events });

    db.exec('RELEASE recall_ingest_session');
    return { units: unitCount, facts: factStats.facts, events: events.length };
  } catch (err) {
    try {
      db.exec('ROLLBACK TO recall_ingest_session');
      db.exec('RELEASE recall_ingest_session');
    } catch {
      // 保持原始错误
    }
    throw err;
  }
}

/**
 * 遍历会话目录，逐个 ingest。
 * 单个会话失败只记录（含路径），不中断整体。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionsRoot
 * @param {{ onProgress?: (info: object) => void }} [options]
 * @returns {{ files: number, sessions: number, units: number, facts: number, events: number, skipped: number, failed: number }}
 */
export function ingestAll(db, sessionsRoot, options = {}) {
  const onProgress = options && typeof options.onProgress === 'function'
    ? options.onProgress
    : null;

  const listed = listSessionFiles(sessionsRoot);
  const files = Array.isArray(listed) ? listed : [];
  const total = files.length;
  let sessions = 0;
  let units = 0;
  let facts = 0;
  let events = 0;
  let skipped = 0;
  let failed = 0;

  files.forEach((file, index) => {
    const path = typeof file === 'string' ? file : file?.path;
    let result = { units: 0, facts: 0, events: 0 };
    let error = null;
    let sessionId = null;

    try {
      if (!path) throw new Error('会话文件缺少 path');
      const parsed = readSessionFile(path);
      const header = { ...(parsed?.header ?? {}) };
      if (!header.id && file && typeof file === 'object' && file.id) header.id = file.id;
      header.path = path;

      result = ingestSession(db, { header, events: parsed?.events ?? [] });
      sessionId = typeof header.id === 'string' ? header.id : null;

      sessions += 1;
      units += result.units;
      facts += Number(result.facts ?? 0);
      events += result.events;
      if (result.units === 0 && result.events === 0) skipped += 1;
    } catch (err) {
      failed += 1;
      error = err instanceof Error ? err.message : String(err);
      console.error(`[recall] ingest failed: ${path ?? '(unknown file)'} — ${error}`);
    }

    if (onProgress) {
      try {
        onProgress({
          index,
          done: index + 1,
          total,
          path: path ?? null,
          id: sessionId,
          units: result.units,
          facts: Number(result.facts ?? 0),
          events: result.events,
          skipped: !error && result.units === 0 && result.events === 0,
          error,
        });
      } catch {
        // 进度回调不能影响入库
      }
    }
  });

  return { files: total, sessions, units, facts, events, skipped, failed };
}
