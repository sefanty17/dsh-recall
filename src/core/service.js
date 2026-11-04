/**
 * 读取路径 · 门面
 *
 * 插件只依赖这一个模块（design 第 4 节：service 是插件唯一依赖的门面）。
 * 约定：所有方法都返回字符串，绝不把异常抛给上层；内部错误统一转成
 * `[memory.error] ...` 文本，让模型至少能看到失败原因。
 *
 *   createService({ db, scope }) → { state, history, search, read, write }
 */

import { randomUUID } from 'node:crypto';

import { search as searchUnits, foldVersions, neighbors } from './search.js';
import {
  formatState,
  formatSearchResult,
  formatHistory,
  formatTime,
  shortId,
  truncate,
} from './format.js';
import { listFacts, factHistory, upsertFact } from './facts.js';

/** 默认返回条数（design 第 5 节）。 */
const DEFAULT_LIMIT = 8;
/** 只为前 N 条命中取邻域，避免一次检索把整个会话读一遍。 */
const NEIGHBOR_BUDGET = 3;

function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function errorText(where, err) {
  const message = err instanceof Error ? err.message : String(err);
  return `[memory.error] ${where}: ${message}`;
}

// ---------------------------------------------------------------------------
// write 的软解析
// ---------------------------------------------------------------------------

/** 引文候选：中文引号 / 书名引号 / 弯引号 / 直引号 / 反引号。 */
const QUOTE_PATTERNS = [
  /「([^」]{1,400})」/g,
  /『([^』]{1,400})』/g,
  /“([^”]{1,400})”/g,
  /"([^"\n]{1,400})"/g,
  /`([^`\n]{1,400})`/g,
];

/** 抽出所有引文，按出现位置排序，去重。 */
export function extractQuotes(content) {
  const found = [];
  for (const re of QUOTE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const text = collapse(m[1]);
      if (text) found.push({ index: m.index, text });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const item of found) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    out.push(item.text);
  }
  return out;
}

/** 证据引用：`@31`，或 `@<session>:31`。 */
export function extractRefs(content) {
  const refs = [];
  const spans = [];
  const withSession = /@([A-Za-z0-9_-]{8,})[:#/](\d{1,9})/g;
  let m;
  while ((m = withSession.exec(content)) !== null) {
    refs.push({ sessionId: m[1], seq: Number(m[2]), index: m.index });
    spans.push([m.index, m.index + m[0].length]);
  }
  const seqOnly = /@(\d{1,9})(?!\d)/g;
  while ((m = seqOnly.exec(content)) !== null) {
    // 别把 `@019c6e8f-...:2` 里的前几位数字再当成一个 @seq
    if (spans.some(([start, end]) => m.index >= start && m.index < end)) continue;
    refs.push({ sessionId: null, seq: Number(m[1]), index: m.index });
  }
  return refs.sort((a, b) => a.index - b.index);
}

/** 引文/证据引用开始的字符：value 到这里就截断，避免把整句引文吞进 value。 */
const QUOTE_START = /[「『“"`]/;

/** 这些"键"其实是叙述引导词（"记住：…"），应该走 note 而不是当成 key。 */
const KEY_STOPWORDS = new Set([
  '记住',
  '记下',
  '记得',
  '注意',
  '备注',
  '结论',
  '提醒',
  'remember',
  'note',
]);

/**
 * value 的右边界（取最先出现的一个）。右边界之后的内容全部进 note：
 *   `pkg-manager=pnpm 依据：CI 只认 pnpm-lock` → value=pnpm、note=依据：…
 * 三类边界：中文说理词、中英文标点、"空白 + 至少 2 个中文字符"。
 */
const VALUE_BOUNDARY_WORDS = ['依据', '理由', '因为', '由于', '原因'];
const VALUE_BOUNDARY_PUNCT = /[，、；;。,]/;
const VALUE_BOUNDARY_SPACE_CJK = /\s(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2})/;

/** 返回 value 的截断位置；没有边界返回 -1。 */
export function findValueBoundary(text) {
  const s = String(text ?? '');
  let best = -1;
  const take = (at) => {
    if (at >= 0 && (best < 0 || at < best)) best = at;
  };
  for (const word of VALUE_BOUNDARY_WORDS) take(s.indexOf(word));
  take(s.search(VALUE_BOUNDARY_PUNCT));
  take(s.search(VALUE_BOUNDARY_SPACE_CJK));
  return best;
}

/** value 清理：去掉尾部的 @证据引用、首尾引号、尾部标点。 */
function cleanValue(text) {
  return String(text ?? '')
    .replace(/\s*@[\w:/-]+\s*$/, '')
    .replace(/^["'「」『』“”]+|["'「」『』“”]+$/g, '')
    .replace(/[，、；;。,]+$/, '')
    .trim();
}

/** note 清理：去掉开头的分隔标点与多余空白。 */
function cleanNote(text) {
  return String(text ?? '')
    .replace(/^[\s，、；;。,]+/, '')
    .replace(/\s+$/, '');
}

/**
 * `key = value` / `key: value` 的软解析。
 * 返回 { key, value, note }：value 为空串表示「有 key 但没解析出值」，由调用方降级成 note。
 */
export function parseKeyValue(content) {
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const m = /^\s*([^\s=:：]{1,40})\s*[=:：]\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];

    if (KEY_STOPWORDS.has(key.toLowerCase())) continue;
    if (/^\d{1,2}$/.test(key) && /^\d{2}/.test(rest)) continue; // 10:20 这种时间
    if (/^https?$/i.test(key)) continue;

    // 引文之前的部分才是 value 的候选区间（引文单独存 quote）
    const quoteAt = rest.search(QUOTE_START);
    const head = quoteAt >= 0 ? rest.slice(0, quoteAt) : rest;

    const boundary = findValueBoundary(head);
    let value = cleanValue(boundary >= 0 ? head.slice(0, boundary) : head);
    let note = cleanNote(boundary >= 0 ? head.slice(boundary) : '');

    // `key = "值"`：value 落在引号里，直接取第一条引文
    if (!value && quoteAt === 0) {
      value = cleanValue(extractQuotes(rest)[0] ?? '');
    }
    // value 确实为空：整行剩余内容都进 note，交给调用方降级
    if (!value && !note) note = cleanNote(rest);

    return { key, value, note };
  }
  return null;
}

/** 自由文本 → 稳定的 key（FNV-1a 6 位十六进制）。避免不同 note 互相 supersede。 */
function noteKey(text) {
  let hash = 0x811c9dc5;
  const s = collapse(text);
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `note-${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

const KIND_HINTS = [
  ['failure', /(失败|装不上|报错|跑不通|挂了|崩了|不行|冲突|error|failed|failure|broken|conflict)/i],
  ['constraint', /(不要|禁止|避免|必须|不能|never|don'?t|do not|must not|avoid)/i],
  ['preference', /(偏好|习惯|喜欢|prefer|favorite|convention)/i],
  ['decision', /(决定|改用|换成|以后都|定下来|decided|switch(ed)? to|we use|chose)/i],
  ['todo', /(待办|下一步|还没做|todo|pending|follow[- ]?up)/i],
];

function inferKind(content) {
  for (const [kind, re] of KIND_HINTS) {
    if (re.test(content)) return kind;
  }
  return 'fact';
}

/** 用 events 原文校验引文；命中则返回精确 span。 */
function verifyQuote(db, sessionId, seq, quote) {
  if (!sessionId || seq == null || !quote) return null;
  let row;
  try {
    row = db
      .prepare('SELECT text FROM events WHERE session_id = ? AND seq = ?')
      .get(sessionId, seq);
  } catch {
    return null;
  }
  const text = row?.text;
  if (typeof text !== 'string' || !text) return null;

  let index = text.indexOf(quote);
  if (index < 0) {
    // 原文里换行/空白与模型引文不完全一致时，退一步比较折叠后的文本。
    const flatText = collapse(text);
    const flatQuote = collapse(quote);
    if (flatQuote && flatText.includes(flatQuote)) {
      index = 0;
      return { verified: true, span_start: 0, span_end: flatQuote.length };
    }
    return null;
  }
  return { verified: true, span_start: index, span_end: index + quote.length };
}

/** 解析证据位置：显式 opts > `@session:seq` > 唯一匹配的 `@seq`。 */
function resolveEvidence(db, refs, opts) {
  const explicitSession = opts.sessionId ?? opts.session_id ?? null;
  const explicitSeq = Number.isFinite(opts.seq) ? Math.floor(opts.seq) : null;

  if (explicitSession) {
    return { sessionId: explicitSession, seq: explicitSeq ?? refs.find((r) => Number.isFinite(r.seq))?.seq ?? null };
  }

  for (const ref of refs) {
    if (ref.sessionId) return { sessionId: ref.sessionId, seq: ref.seq };
  }

  for (const ref of refs) {
    if (!Number.isFinite(ref.seq)) continue;
    let rows = [];
    try {
      rows = db.prepare('SELECT session_id, seq FROM events WHERE seq = ?').all(ref.seq);
    } catch {
      rows = [];
    }
    if (rows.length === 1) return { sessionId: rows[0].session_id, seq: rows[0].seq };
  }

  return { sessionId: null, seq: explicitSeq };
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object} deps.db     openDb() 的 DatabaseSync
 * @param {string} deps.scope  项目 cwd，或 'global'
 */
export function createService({ db, scope } = {}) {
  const defaultScope = String(scope ?? '').trim() || 'global';

  function state() {
    try {
      // 常驻状态表只列 typed facts（key !== 'note'）；note 只走 search，保证可信度
      const facts = listFacts(db, { scope: defaultScope })
        .filter((fact) => fact.key !== 'note');
      return formatState(facts, { scope: defaultScope });
    } catch (err) {
      return errorText('state', err);
    }
  }

  function history(key) {
    try {
      if (!key) return '[memory.error] history: 需要 key';
      const facts = factHistory(db, { key: String(key), scope: defaultScope });
      return formatHistory(facts, { key: String(key), scope: defaultScope });
    } catch (err) {
      return errorText('history', err);
    }
  }

  function search(query, opts = {}) {
    try {
      const q = String(query ?? '').trim();
      if (!q) return '[memory.error] search: query 不能为空';

      const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
      const includeSuperseded = Boolean(opts.includeSuperseded);
      const searchScope = String(opts.scope ?? '').trim() || defaultScope;

      const raw = searchUnits(db, { query: q, scope: searchScope, limit, includeSuperseded });
      const folded = foldVersions(db, raw);

      // 预算内补邻域：只给前几条，且任何一条失败都不影响整体结果。
      for (let i = 0; i < Math.min(folded.length, NEIGHBOR_BUDGET); i += 1) {
        try {
          folded[i].neighbors = neighbors(db, folded[i], { before: 1, after: 1 });
        } catch {
          folded[i].neighbors = [];
        }
      }

      return formatSearchResult(folded, {
        scope: searchScope,
        includeSuperseded,
        query: q,
        limit,
      });
    } catch (err) {
      return errorText('search', err);
    }
  }

  /**
   * 读一条事件原文 + 前后各 1 条。原文只读，不做任何改写。
   * 注意：这是 service 的 read，不是工具的 action（工具契约只有四个 action）。
   */
  function read(sessionId, seq) {
    try {
      const sid = String(sessionId ?? '').trim();
      const target = Number(seq);
      if (!sid) return '[memory.error] read: 需要 session_id';
      if (!Number.isFinite(target)) return '[memory.error] read: 需要数字 seq';

      const rows = db
        .prepare(
          `SELECT seq, type, time, surface, author, text
           FROM events
           WHERE session_id = ? AND seq BETWEEN ? AND ?
           ORDER BY seq ASC`,
        )
        .all(sid, target - 1, target + 1);

      if (!rows.length) {
        return `[memory.error] read: session=${shortId(sid)} seq=${Math.floor(target)} 没有这条事件`;
      }

      const isTarget = (row) => row.seq === Math.floor(target);
      const lines = [
        `[memory.read] session=${shortId(sid)} seq=${Math.floor(target)} · ${rows.length} events`,
      ];
      for (const row of rows) {
        const flags = isTarget(row) ? ' · TARGET' : '';
        lines.push(
          `── seq ${row.seq} · ${row.author ?? row.type ?? 'unknown'} · ` +
            `${formatTime(row.time)}${row.surface ? ` · ${row.surface}` : ''}${flags} ──`,
        );
        const text = row.text == null || row.text === '' ? '（空）' : String(row.text);
        lines.push(isTarget(row) ? text : truncate(text, 1200));
      }
      return lines.join('\n');
    } catch (err) {
      return errorText('read', err);
    }
  }

  /**
   * 软解析写入。内容里的引文决定 quote / verified；没有引文就退化成 note。
   * 返回一行摘要：`[memory.write] ok · fact key=value · verified=...`
   */
  function write(content, opts = {}) {
    try {
      const text = String(content ?? '').trim();
      if (!text) return '[memory.error] write: content 不能为空';

      const quotes = extractQuotes(text);
      const refs = extractRefs(text);
      const parsed = parseKeyValue(text);
      const quote = quotes[0] ?? null;
      const evidence = resolveEvidence(db, refs, opts ?? {});
      const check = quote ? verifyQuote(db, evidence.sessionId, evidence.seq, quote) : null;
      const verified = Boolean(check?.verified);

      // parsed.value 为空 = 有 key 但没解析出值（如 `pkg-manager=`）：
      // 降级成 note 型事实，绝不产生空 value 的 typed fact。
      const degraded = Boolean(parsed) && !parsed.value;
      const key = String(
        opts.key ?? (degraded ? noteKey(quote ?? text) : parsed?.key ?? noteKey(quote ?? text)),
      );
      const factScope = String(opts.scope ?? '').trim() || defaultScope;
      const kind = String(opts.kind ?? (quote ? inferKind(text) : 'fact'));
      const value = (parsed?.value || null) ?? (quote ?? null);
      // 有 key=value 结构时，只有右边界之后的内容进 note；自由文本整段进 note。
      const noteText = degraded
        ? parsed?.note || text
        : parsed
          ? parsed.note || null
          : quote
            ? null
            : text;
      const now = Number.isFinite(opts.now) ? opts.now : Date.now();

      const fact = {
        id: randomUUID(),
        key,
        value,
        scope: factScope,
        kind,
        status: 'active',
        since: now,
        verified_at: verified ? now : null,
        drift: 'stable',
        quote,
        note: noteText,
        author: String(opts.author ?? 'agent'),
        verified: verified ? 1 : 0,
        evidence_session: evidence.sessionId ?? null,
        evidence_seq: evidence.seq ?? null,
        span_start: check?.span_start ?? null,
        span_end: check?.span_end ?? null,
        supersedes: null,
        superseded_by: null,
        created_at: now,
        // camelCase 别名：facts.js 若按驼峰读取也能拿到同样的值。
        evidenceSession: evidence.sessionId ?? null,
        evidenceSeq: evidence.seq ?? null,
        createdAt: now,
        verifiedAt: verified ? now : null,
      };

      const result = upsertFact(db, fact);
      const saved = result?.fact ?? result ?? fact;
      const supersededRaw = result?.superseded ?? result?.supersededCount ?? 0;
      // facts.js 的 superseded 是旧 fact id（字符串）；也兼容数组 / 数字。
      const supersededCount = Array.isArray(supersededRaw)
        ? supersededRaw.length
        : typeof supersededRaw === 'string'
          ? (supersededRaw ? 1 : 0)
          : Number.isFinite(supersededRaw)
            ? Number(supersededRaw)
            : 0;

      const shown = saved?.value
        ?? (saved?.quote
          ? truncate(String(saved.quote), 40)
          : saved?.note
            ? truncate(String(saved.note), 40)
            : '(note)');
      const parts = [
        '[memory.write] ok',
        `fact ${saved?.key ?? key}=${shown}`,
        `verified=${verified}`,
      ];
      if (supersededCount > 0) parts.push(`superseded ${supersededCount}`);
      if (evidence.seq != null) parts.push(`evidence e${evidence.seq}`);
      return parts.join(' · ');
    } catch (err) {
      return errorText('write', err);
    }
  }

  return { state, history, search, read, write };
}
