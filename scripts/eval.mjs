#!/usr/bin/env node
// 评测：批量跑查询，分组输出 Hit@1 / MRR / 平均条数 / 平均耗时。
//
//   node scripts/eval.mjs [--db ./.dev/index.db] [--queries eval/queries.jsonl]   # 默认 manual
//   node scripts/eval.mjs --manual [--queries <file>]
//   node scripts/eval.mjs --auto [--max-queries 20]
//   node scripts/eval.mjs --auto --manual                                          # 两组分开报告
//   node scripts/eval.mjs --queries eval/queries-gen.jsonl --db .dev/l2.db         # 任意 JSONL
//   node scripts/eval.mjs --queries <file> --db <db> --baseline grep               # 对比基线
//
// --auto：从 facts 表生成查询。query = 该事实 quote 清洗后的前 12–20 字片段，
//         expect = 它自己的 evidence；用来做「索引/定位自洽性」检查，而不是检索质量。
// --queries：跑任意 JSONL（例如 scripts/gen-queries.mjs 生成的模型改写问题），
//         单独给出时进入 queries 模式，报告前 5 条 miss；不能与 --auto 同用。
// --baseline：同一个查询文件换一种检索跑，只输出一行对比指标：
//         ours（默认）= search() 全流程；grep = units.text LIKE '%query%' 取最新一条；
//         phrase = ftsPhrase(query) 整句 phrase，bm25 第一条。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core/db.js';
import { ftsPhrase } from '../src/core/chunk.js';
import { search } from '../src/core/search.js';

const DEFAULTS = {
  db: path.resolve('.dev', 'index.db'),
  queries: path.resolve('eval', 'queries.jsonl'),
  limit: 8,
  misses: 3,
};

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const MIN_SNIPPET = 6;
const TAKE_CHARS = 16;
const MAX_CHARS = 20;

const HELP = `dsh-recall eval

  node scripts/eval.mjs [--db <file>] [--queries <file>] [--limit 8] [--scope <cwd>] [--verbose]
  node scripts/eval.mjs --manual [--queries <file>] [--misses 3]
  node scripts/eval.mjs --auto [--max-queries 20] [--misses 3]
  node scripts/eval.mjs --queries <file> [--misses 5]           # queries 模式
  node scripts/eval.mjs --queries <file> --baseline <mode>       # 对比基线（ours|grep|phrase）
  node scripts/eval.mjs --auto --manual

  --auto      从 facts.quote 生成自洽性查询（片段 ≥${MIN_SNIPPET} 字，前 12–20 字）
  --manual    跑手写查询文件（默认模式）
  --queries   跑任意 JSONL（如 gen-queries 输出）；单独使用时为 queries 模式，
              报告前 5 条 miss（query 前 30 字 + 期望/实际 seq）。与 --auto 互斥；
              与 --manual 同用时等同于指定手写查询文件（兼容旧用法）。
  --baseline  换一种检索跑同一个查询文件，只打印一行 [baseline] 指标：
              ours（默认）= search() 全流程；
              grep        = units.text LIKE '%query%'，按 time DESC 取第一条；
              phrase      = ftsPhrase(query) 整句 phrase，bm25 第一条。
              与 --auto 互斥。
  --verbose   打印每条查询的命中情况

JSONL 每行：{ "query": "...", "scope": "D:\\\\path", "expect": { "session_id": "...", "seq": 12 } | null, "note": "..." }
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { flags, positional };
}

function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      console.error(`[eval] 跳过第 ${lineNo} 行（JSON 解析失败）：${error.message}`);
    }
  }
  return rows;
}

/**
 * 清掉 markdown 修饰与多余空白，保留可检索的正文。
 * 例：'**必须真的调用 web_search**' → '必须真的调用 web_search'
 */
function cleanQuote(quote) {
  return String(quote ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*~#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取 quote 的前 12–20 字作为查询片段。
 * 中文按字截（最多 20 字，末尾切开英文单词时回退到词边界）；
 * 纯英文按词边界累加到 16–20 字。小于 6 字返回 null。
 */
function quoteSnippet(quote) {
  const text = cleanQuote(quote);
  if (!text) return null;
  const chars = Array.from(text);
  let snippet;

  if (CJK.test(text)) {
    snippet = chars.slice(0, MAX_CHARS).join('');
    // 截断点落在英文单词中间时，丢掉半个词，避免 phrase 永远匹配不上。
    if (chars.length > MAX_CHARS) {
      const last = chars[MAX_CHARS - 1];
      const next = chars[MAX_CHARS];
      if (/[A-Za-z0-9_]/.test(last) && /[A-Za-z0-9_]/.test(next)) {
        snippet = snippet.replace(/[A-Za-z0-9_]+$/, '').trimEnd();
      }
    }
  } else {
    const words = text.split(' ').filter(Boolean);
    snippet = '';
    for (const word of words) {
      const candidate = snippet ? `${snippet} ${word}` : word;
      if (snippet && Array.from(candidate).length > MAX_CHARS) break;
      snippet = candidate;
      if (Array.from(snippet).length >= TAKE_CHARS) break;
    }
  }

  // 去掉两端标点/emoji（引号、逗号、括号、❌✅ 等），正文里的保持不变。
  snippet = snippet
    .replace(/^[\s\p{Extended_Pictographic},.!?;:'"“”‘’()[\]{}<>，。！？；：、（）【】《》]+/u, '')
    .replace(/[\s\p{Extended_Pictographic},.!?;:'"“”‘’()[\]{}<>，。！？；：、（）【】《》]+$/u, '')
    .trim();

  const length = Array.from(snippet).length;
  if (length < MIN_SNIPPET) return null;
  return Array.from(snippet).slice(0, MAX_CHARS).join('');
}

function hitSessionId(hit) {
  return hit?.unit?.session_id ?? hit?.session?.id ?? hit?.event?.session_id ?? null;
}

function hitSeq(hit) {
  return hit?.event?.seq ?? hit?.unit?.seq ?? null;
}

function isSameEvidence(hit, expect) {
  if (!expect) return false;
  if (String(hitSessionId(hit)) !== String(expect.session_id)) return false;
  return Number(hitSeq(hit)) === Number(expect.seq);
}

function shortId(id) {
  const text = String(id ?? '?');
  const prefix = text.startsWith('session-') ? 'session-' : '';
  const rest = text.slice(prefix.length);
  return `${prefix}${rest.slice(0, 8)}${rest.length > 8 ? '…' : ''}`;
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`;
}

/**
 * 三种检索共用的 Hit@1 判定（保证口径一致）：
 *   hit1  = 返回列表第 1 条是否等于 expect（同时比 session_id 和 seq）
 *   rank  = expect 在列表中的 1-based 位置，0 表示未命中（MRR 用）
 */
function hitAt1(hits, expect) {
  const list = Array.isArray(hits) ? hits : [];
  const top = list[0] ?? null;
  if (!expect) return { hit1: false, rank: 0, top };
  const index = list.findIndex((hit) => isSameEvidence(hit, expect));
  return { hit1: index === 0, rank: index === -1 ? 0 : index + 1, top };
}

async function runQueries(db, queries, { limit, fallbackScope, verbose, group, includeSuperseded = false }) {
  const results = [];
  for (const row of queries) {
    const query = String(row?.query ?? '').trim();
    if (!query) continue;
    const scope = row.scope ?? fallbackScope ?? process.cwd();
    const startedAt = process.hrtime.bigint();
    let hits = [];
    let error = null;
    try {
      const found = search(db, { query, scope, limit, includeSuperseded });
      hits = Array.isArray(found) ? found : [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const expect = row.expect ?? null;
    const { hit1, rank, top } = hitAt1(hits, expect);
    const result = { query, scope, expect, hits, ms, rank, hit1, error, note: row.note };
    results.push(result);
    if (verbose) {
      const topText = top ? `${shortId(hitSessionId(top))}#${hitSeq(top)}` : '—';
      const verdict = error
        ? `ERROR ${error}`
        : expect
          ? hit1
            ? 'HIT@1'
            : rank > 0
              ? `HIT@${rank}`
              : 'MISS'
          : 'no-expect';
      console.log(
        `[eval] ${group} ${results.length}. "${query}" scope=${scope} · hits=${hits.length} · top=${topText} · ${formatMs(ms)} · ${verdict}`,
      );
    }
  }
  return results;
}

function summarize(results) {
  const withExpect = results.filter((row) => row.expect);
  const hit1 = withExpect.filter((row) => row.rank === 1).length;
  const reciprocalSum = withExpect.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0);
  const totalHits = results.reduce((sum, row) => sum + row.hits.length, 0);
  const totalMs = results.reduce((sum, row) => sum + row.ms, 0);
  return {
    queries: results.length,
    withExpect: withExpect.length,
    hit1,
    hit1Rate: withExpect.length ? hit1 / withExpect.length : null,
    mrr: withExpect.length ? reciprocalSum / withExpect.length : null,
    avgHits: results.length ? totalHits / results.length : 0,
    avgMs: results.length ? totalMs / results.length : 0,
    errors: results.filter((row) => row.error).length,
  };
}

// ---------------------------------------------------------------------------
// 对比基线：ours / grep / phrase
// ---------------------------------------------------------------------------

const BASELINE_MODES = ['ours', 'grep', 'phrase'];

/** LIKE 通配符转义：query 里的 \、%、_ 都按字面量匹配。 */
function escapeLike(text) {
  return String(text ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function baselineScope(scope) {
  const value = String(scope ?? '').trim();
  return value && value !== 'global' ? value : null;
}

function baselineHit(row, reason) {
  return {
    unit: {
      id: row.id,
      session_id: row.session_id,
      seq: row.seq,
      start: row.start,
      end: row.end,
      text: row.text,
      time: row.time,
      author: row.author,
      surface: row.surface,
    },
    event: null,
    session: {
      id: row.session_id,
      cwd: row.session_cwd,
      path: row.session_path,
      created_at: row.session_created_at,
      parent_id: row.session_parent_id,
      origin: row.session_origin,
    },
    score: 0,
    reasons: [reason],
  };
}

/** grep 派：units.text 做大小写不敏感的 LIKE，按 time DESC 取最新一条。 */
function grepTopHit(db, { query, scope }) {
  const pattern = `%${escapeLike(query)}%`;
  const scoped = baselineScope(scope);
  const sql = `
    SELECT
      u.id, u.session_id, u.seq, u.start, u.end, u.text, u.time, u.author, u.surface,
      s.cwd AS session_cwd, s.path AS session_path, s.created_at AS session_created_at,
      s.parent_id AS session_parent_id, s.origin AS session_origin
    FROM units u
    JOIN sessions s ON s.id = u.session_id
    WHERE u.text LIKE ? ESCAPE '\\'
      ${scoped ? 'AND s.cwd = ?' : ''}
    ORDER BY COALESCE(u.time, s.created_at) DESC, u.id DESC
    LIMIT 1`;
  const rows = db.prepare(sql).all(...(scoped ? [pattern, scoped] : [pattern]));
  return rows.map((row) => baselineHit(row, 'baseline:grep'));
}

/** 朴素 RAG：只做 ftsPhrase(query) 整句 phrase，不用 bigram 回退、不加覆盖率。 */
function phraseTopHit(db, { query, scope }) {
  let phrase;
  try {
    phrase = ftsPhrase(query);
  } catch {
    return [];
  }
  if (!phrase) return [];
  const scoped = baselineScope(scope);
  const sql = `
    SELECT
      u.id, u.session_id, u.seq, u.start, u.end, u.text, u.time, u.author, u.surface,
      s.cwd AS session_cwd, s.path AS session_path, s.created_at AS session_created_at,
      s.parent_id AS session_parent_id, s.origin AS session_origin
    FROM unit_fts
    JOIN units u ON u.id = unit_fts.unit_id
    JOIN sessions s ON s.id = u.session_id
    WHERE unit_fts MATCH ?
      ${scoped ? 'AND s.cwd = ?' : ''}
    ORDER BY bm25(unit_fts)
    LIMIT 1`;
  const rows = db.prepare(sql).all(...(scoped ? [phrase, scoped] : [phrase]));
  return rows.map((row) => baselineHit(row, 'baseline:phrase'));
}

async function runBaselineQueries(db, queries, { mode, limit, fallbackScope, verbose }) {
  const results = [];
  for (const row of queries) {
    const query = String(row?.query ?? '').trim();
    if (!query) continue;
    const scope = row.scope ?? fallbackScope ?? process.cwd();
    const expect = row.expect ?? null;
    const startedAt = process.hrtime.bigint();
    let hits = [];
    let error = null;
    try {
      if (mode === 'grep') hits = grepTopHit(db, { query, scope });
      else if (mode === 'phrase') hits = phraseTopHit(db, { query, scope });
      else hits = search(db, { query, scope, limit });
      if (!Array.isArray(hits)) hits = [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      hits = [];
    }
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const { hit1, rank, top } = hitAt1(hits, expect);
    results.push({ query, scope, expect, hits, ms, rank, hit1, error, note: row.note });

    if (verbose) {
      const topText = top ? `${shortId(hitSessionId(top))}#${hitSeq(top)}` : '—';
      const verdict = error
        ? `ERROR ${error}`
        : !expect
          ? 'no-expect'
          : hit1
            ? 'HIT@1'
            : rank > 0
              ? `HIT@${rank}`
              : 'MISS';
      console.log(
        `[baseline] ${mode} ${results.length}. "${query}" scope=${scope} · hits=${hits.length} · top=${topText} · ${formatMs(ms)} · ${verdict}`,
      );
    }
  }
  return results;
}

function printBaselineLine(mode, summary) {
  const pct = summary.hit1Rate == null ? 'n/a' : `${(summary.hit1Rate * 100).toFixed(1)}%`;
  const mrr = summary.mrr == null ? 'n/a' : summary.mrr.toFixed(3);
  console.log(
    `[baseline] ${mode.padEnd(7)}Hit@1 ${pct} (${summary.hit1}/${summary.withExpect})`
      + ` · MRR ${mrr}`
      + ` · 平均 ${summary.avgHits.toFixed(1)} 条`
      + ` · ${formatMs(summary.avgMs)}`,
  );
}

function printSummary(summary, group) {
  const pct = summary.hit1Rate == null ? 'n/a' : `${(summary.hit1Rate * 100).toFixed(1)}%`;
  const mrr = summary.mrr == null ? 'n/a' : summary.mrr.toFixed(3);
  console.log(
    `[eval] ${group}: Hit@1 ${pct} (${summary.hit1}/${summary.withExpect})` +
      ` · MRR ${mrr}` +
      ` · 平均 ${summary.avgHits.toFixed(1)} 条` +
      ` · 平均 ${formatMs(summary.avgMs)}` +
      (summary.errors ? ` · 错误 ${summary.errors}` : ''),
  );
}

function reportGroup(group, results, { verbose, missLimit }) {
  if (results.length === 0) {
    console.log(`[eval] ${group}: 没有查询可跑。`);
    return;
  }
  const summary = summarize(results);
  printSummary(summary, group);
  if (verbose) return;
  const misses = results.filter((row) => row.expect && row.rank !== 1);
  for (let i = 0; i < Math.min(misses.length, missLimit); i += 1) {
    const row = misses[i];
    const expectText = `${shortId(row.expect.session_id)}#${row.expect.seq}`;
    const top = row.hits[0] ? `${shortId(hitSessionId(row.hits[0]))}#${hitSeq(row.hits[0])}` : '—';
    console.log(
      `[eval] ${group} miss ${i + 1}/${misses.length}: "${row.query}"` +
        ` 期望 ${expectText}${row.rank ? ` 排第 ${row.rank}` : ' 未命中'} · top=${top}`,
    );
  }
}

/** queries 模式：query 前 30 字 + 期望/实际 seq，默认看前 5 条 miss。 */
function truncateQuery(text, max = 30) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('')}…`;
}

function reportQueries(group, results, { verbose, missLimit }) {
  if (results.length === 0) {
    console.log(`[eval] ${group}: 没有查询可跑。`);
    return;
  }
  printSummary(summarize(results), group);
  if (verbose) return;
  const misses = results.filter((row) => row.expect && row.rank !== 1);
  for (let i = 0; i < Math.min(misses.length, missLimit); i += 1) {
    const row = misses[i];
    const top = row.hits[0];
    const expected = `${shortId(row.expect.session_id)}#${row.expect.seq}`;
    const actual = top ? `${shortId(hitSessionId(top))}#${hitSeq(top)}` : '（无结果）';
    console.log(
      `[eval] ${group} miss ${i + 1}/${misses.length}: "${truncateQuery(row.query, 30)}"`
        + ` 期望 ${expected} · 实际 ${actual}`
        + `${row.rank ? `（排第 ${row.rank}）` : ''}`,
    );
  }
}

/** 用事实自己的 quote 片段生成查询；expect = 它自己的 evidence。 */
function loadAutoQueries(db) {
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT key, value, quote, scope, status, evidence_session, evidence_seq
           FROM facts
          ORDER BY created_at DESC`,
      )
      .all();
  } catch (error) {
    console.error(`[eval] 读取 facts 失败：${error.message}`);
    return { queries: [], total: 0, skipped: 0, noQuote: 0, tooShort: 0, noEvidence: 0 };
  }

  const queries = [];
  let noQuote = 0;
  let tooShort = 0;
  let noEvidence = 0;
  for (const row of rows) {
    if (row.evidence_session == null || row.evidence_seq == null) {
      noEvidence += 1;
      continue;
    }
    const quote = String(row.quote ?? '').trim();
    if (!quote) {
      noQuote += 1;
      continue;
    }
    const snippet = quoteSnippet(quote);
    if (!snippet) {
      tooShort += 1;
      continue;
    }
    queries.push({
      query: snippet,
      scope: row.scope ?? null,
      expect: { session_id: row.evidence_session, seq: Number(row.evidence_seq) },
      note: `auto: ${row.key}=${row.value} (${row.status})`,
    });
  }
  return {
    queries,
    total: rows.length,
    skipped: noQuote + tooShort + noEvidence,
    noQuote,
    tooShort,
    noEvidence,
  };
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const dbPath = path.resolve(expandHome(flags.db ?? DEFAULTS.db));
  if (!fs.existsSync(dbPath)) {
    console.error(`[eval] 数据库不存在：${dbPath}\n[eval] 先跑：node scripts/dev.mjs ingest --db ${dbPath}`);
    process.exitCode = 1;
    return;
  }
  const limit = Number(flags.limit ?? DEFAULTS.limit) || DEFAULTS.limit;
  const missLimit = Math.max(0, Number(flags.misses ?? DEFAULTS.misses) || DEFAULTS.misses);
  const verbose = Boolean(flags.verbose) || Boolean(flags.v);
  const wantAuto = Boolean(flags.auto);
  const explicitManual = Boolean(flags.manual);

  // --baseline：换一种检索跑同一个查询文件；缺省模式为 ours。
  let baselineMode = null;
  if (flags.baseline !== undefined) {
    const raw = flags.baseline === true
      ? 'ours'
      : String(flags.baseline).trim().toLowerCase();
    if (!BASELINE_MODES.includes(raw)) {
      console.error(`[eval] --baseline 只能是 ${BASELINE_MODES.join('|')}，收到：${flags.baseline}`);
      process.exitCode = 1;
      return;
    }
    baselineMode = raw;
  }
  if (baselineMode && wantAuto) {
    console.error('[eval] --baseline 不能与 --auto 同用（--baseline 需要查询文件）');
    process.exitCode = 1;
    return;
  }

  // --queries 有三种身份：queries 模式（单独给出）、manual 的查询文件（配合 --manual）、
  // 以及和 --auto 的冲突配置。只允许字符串路径。
  const queriesFlag = flags.queries;
  if (queriesFlag !== undefined
    && (typeof queriesFlag !== 'string' || queriesFlag.trim() === '')) {
    console.error('[eval] --queries 需要一个非空的 JSONL 文件路径');
    process.exitCode = 1;
    return;
  }
  if (queriesFlag !== undefined && wantAuto) {
    console.error('[eval] --queries 与 --auto 不能同时使用（--auto 的查询由 facts 生成）');
    process.exitCode = 1;
    return;
  }
  // 默认 manual；显式 --manual 与 --auto 可以同时出现，两组分别报告。
  // 单独给 --queries 时进入 queries 模式，避免默认 manual 抢走这个路径。
  const wantQueries = queriesFlag !== undefined && !wantAuto && !explicitManual;
  const wantManual = explicitManual || (!wantAuto && !wantQueries);
  const file = path.resolve(expandHome(queriesFlag ?? DEFAULTS.queries));
  const maxQueries = Number(flags['max-queries'] ?? flags.max);
  const queryMissLimit = flags.misses === undefined ? 5 : missLimit;

  const db = openDb(dbPath);
  try {
    if (baselineMode) {
      if (!fs.existsSync(file)) {
        console.error(`[eval] 查询文件不存在：${file}`);
        process.exitCode = 1;
        return;
      }
      const queries = readJsonl(file);
      const results = await runBaselineQueries(db, queries, {
        mode: baselineMode,
        limit,
        fallbackScope: flags.scope,
        verbose,
      });
      printBaselineLine(baselineMode, summarize(results));
      return;
    }

    let ranGroup = false;

    if (wantAuto) {
      const generated = loadAutoQueries(db);
      let queries = generated.queries;
      if (Number.isFinite(maxQueries) && maxQueries > 0) {
        queries = queries.slice(0, Math.floor(maxQueries));
      }
      console.log(
        `[eval] auto: ${queries.length} 条查询` +
          (queries.length < generated.queries.length
            ? `（共 ${generated.queries.length}，截断到 ${queries.length}）`
            : '') +
          ` · facts ${generated.total} · 跳过 ${generated.skipped}` +
          `（无 quote ${generated.noQuote} / 片段太短 ${generated.tooShort} / 缺 evidence ${generated.noEvidence}）` +
          ' · includeSuperseded=true（测索引自洽，不按 active 过滤证据）' +
          ` · db=${dbPath}`,
      );
      const results = await runQueries(db, queries, {
        limit,
        fallbackScope: flags.scope,
        verbose,
        group: 'auto',
        includeSuperseded: true,
      });
      reportGroup('auto', results, { verbose, missLimit });
      ranGroup = true;
    }

    if (wantQueries) {
      if (!fs.existsSync(file)) {
        console.error(`[eval] 查询文件不存在：${file}`);
        process.exitCode = 1;
        return;
      }
      const queries = readJsonl(file);
      console.log(`[eval] queries: ${queries.length} 条查询 · ${file}`);
      const results = await runQueries(db, queries, {
        limit,
        fallbackScope: flags.scope,
        verbose,
        group: 'queries',
      });
      reportQueries('queries', results, { verbose, missLimit: queryMissLimit });
      ranGroup = true;
    }

    if (wantManual) {
      if (!fs.existsSync(file)) {
        console.error(`[eval] 查询文件不存在：${file}`);
        process.exitCode = 1;
        return;
      }
      const queries = readJsonl(file);
      console.log(`[eval] manual: ${queries.length} 条查询 · ${file}`);
      const results = await runQueries(db, queries, {
        limit,
        fallbackScope: flags.scope,
        verbose,
        group: 'manual',
      });
      reportGroup('manual', results, { verbose, missLimit });
      ranGroup = true;
    }

    if (!ranGroup) console.log('[eval] 没有查询可跑。');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`[eval] 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
