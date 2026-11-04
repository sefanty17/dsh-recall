#!/usr/bin/env node
// 评测问题生成：把 facts 表里的事实改写成「开发者会自然问出口的问题」。
//
//   node scripts/gen-queries.mjs --db .dev/l2.db --out eval/queries-gen.jsonl \
//     [--limit 40] [--per-fact 2]
//
// 输出 JSONL，每行：
//   {"query":"...","scope":"D:\\...","expect":{"session_id":"...","seq":123},
//    "fact_id":"...","source":"llm"}
//
// 与 --auto（照抄 quote 片段）互补：这里的问题由模型改写，用来测「自然问句 → 原始证据」。
//
// 安全：
//   - 只读 facts 表；不打开、不写入任何会话文件
//   - 密钥只经 resolveLlmConfig() 读取，不打印、不写文件
//   - 所有错误信息先过 redactSecrets()，sk- 开头的串替换成 <redacted>
//
// 幂等：--out 已存在时只追加，并按 fact_id+query 去重；重复运行不会产生重复行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/core/db.js';
import { chatJson, redactSecrets, resolveLlmConfig } from '../src/core/llm.js';

const DEFAULTS = {
  db: path.resolve('.dev', 'l2.db'),
  out: path.resolve('eval', 'queries-gen.jsonl'),
  limit: 40,
  perFact: 2,
};

/** 问题长度闸门：太短没信息量，太长多半是模型跑题。 */
const MIN_QUERY_CHARS = 4;
const MAX_QUERY_CHARS = 120;

/** 「根据记忆」类元话术：评测问题里出现就说明模型在演，不是在问。 */
const META_PATTERN =
  /根据\s*(?:记忆|记录|之前的对话|上文|历史)|你(?:还)?记得|记忆库|记忆里|之前的对话|刚才说的|上面说的/;

/** quote 至少这么长才做「照抄」检查，避免把 pnpm / 3000 这种短值误判。 */
const QUOTE_ECHO_MIN_CHARS = 6;

/** 至少含一个汉字才算「自然中文问题」；纯英文问句直接丢掉。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const HELP = `dsh-recall 评测问题生成（模型参与）

  node scripts/gen-queries.mjs [--db <file>] [--out <file>]
    [--limit 40] [--per-fact 2]

  --db        索引库文件（默认 ${DEFAULTS.db}）
  --out       输出 JSONL（默认 ${DEFAULTS.out}，已存在时追加并按 fact_id+query 去重）
  --limit     最多取多少条 active 事实（按 created_at 从新到旧，默认 ${DEFAULTS.limit}）
  --per-fact  每条事实生成几个问题（默认 ${DEFAULTS.perFact}）

  只取 status='active' 且带 evidence_session / evidence_seq 的事实；缺 evidence 的跳过。
  模型调用失败重试 1 次，仍失败则跳过该条事实，最后打印成功率。

  凭据顺序：DSH_RECALL_API_KEY / DEEPSEEK_API_KEY / ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
  没有凭据时打印「未配置模型凭据，跳过查询生成」并退出（退出码 0）。
`;

// ---------------------------------------------------------------------------
// 参数 / 小工具
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
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
  return flags;
}

function expandHome(input) {
  if (typeof input !== 'string') return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 比对用的归一化：去空白、转小写。 */
function normalizeForMatch(text) {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase();
}

/** 模型给的问题：去首尾引号 / 多余空白。 */
function normalizeQuery(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function clip(text, limit) {
  const value = collapse(text);
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const normalize = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return normalize(path.resolve(entry)) === normalize(path.resolve(self));
}

// ---------------------------------------------------------------------------
// 事实 → prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是「开发者提问生成器」。给定一条开发者在本项目里说过或确认过的事实，写出他会自然问助手的中文问题，只输出 JSON。

要求：
- 问题要像开发者随口说的：口语、具体、简短。例如「这个项目数据库用的什么版本」「上次那个报错最后怎么解的」。
- 每条问题都必须能由给定事实回答；问题之间换不同角度，不要只改一两个字。
- 不要照抄「原文引文」里的句子，也不要把答案原样塞进问题。
- 不要出现「根据记忆」「根据之前的对话」「你记得吗」这类元话术，也不要提「事实」「记忆库」「评测」。
- 只输出 JSON：{"queries":["问题1","问题2"]}`;

const MAX_PROMPT_QUOTE_CHARS = 500;

/**
 * 构造一条事实的生成 prompt。
 * @param {object} fact facts 表的一行（至少含 key/value/kind/quote/note/scope）
 * @param {number} perFact 生成几个问题
 * @returns {Array<{role: 'system'|'user', content: string}>}
 */
export function buildQueryMessages(fact, perFact = 1) {
  const lines = [`项目：${nonEmpty(fact?.scope) ? fact.scope : 'global'}`, `键：${fact?.key ?? 'note'}`];
  if (nonEmpty(fact?.value)) lines.push(`值：${collapse(fact.value)}`);
  if (nonEmpty(fact?.kind)) lines.push(`类型：${fact.kind}`);
  if (nonEmpty(fact?.quote)) {
    lines.push(`原文引文：${clip(fact.quote, MAX_PROMPT_QUOTE_CHARS)}`);
  }
  if (nonEmpty(fact?.note)) lines.push(`备注：${clip(fact.note, MAX_PROMPT_QUOTE_CHARS)}`);
  lines.push('', `请生成 ${perFact} 个问题，问法要有区分度。`);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

// ---------------------------------------------------------------------------
// 模型返回 → 问题列表
// ---------------------------------------------------------------------------

function stripFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) return trimmed.slice(3).replace(/```\s*$/, '').trim();
  return trimmed.slice(firstBreak + 1).replace(/```\s*$/, '').trim();
}

function parseModelJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') {
    throw new TypeError('模型返回既不是对象也不是字符串');
  }
  const candidates = [raw.trim()];
  const fenced = stripFence(raw);
  if (fenced !== candidates[0]) candidates.push(fenced);
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(raw.slice(open, close + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 试下一种候选
    }
  }
  throw new Error(`模型返回无法解析为 JSON（开头：${redactSecrets(clip(raw, 120))}）`);
}

/**
 * 从模型返回里取出问题数组（兼容 {queries:[...]}、{questions:[...]}、顶层数组）。
 * 只做结构解析，不做业务过滤；坏元素静默跳过。
 * @param {object|string} raw
 * @returns {string[]}
 */
export function parseGeneratedQueries(raw) {
  const parsed = parseModelJson(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed?.queries ?? parsed?.questions);
  if (!Array.isArray(list)) {
    throw new Error('模型返回缺少 queries 数组');
  }
  const out = [];
  for (const item of list) {
    const value = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? item.query ?? item.question : '');
    const query = normalizeQuery(value);
    if (query && !out.includes(query)) out.push(query);
  }
  return out;
}

/**
 * 业务过滤：长度、元话术、照抄 quote；去重后最多留 perFact 条。
 * @param {string[]} queries
 * @param {object} fact
 * @param {number} perFact
 * @returns {string[]}
 */
export function filterQueries(queries, fact, perFact = Infinity) {
  const quote = normalizeForMatch(fact?.quote);
  const out = [];
  for (const raw of Array.isArray(queries) ? queries : []) {
    const query = normalizeQuery(raw);
    if (!query) continue;
    if (!CJK.test(query)) continue;
    const length = Array.from(query).length;
    if (length < MIN_QUERY_CHARS || length > MAX_QUERY_CHARS) continue;
    if (META_PATTERN.test(query)) continue;
    // 问题里逐字带上了 quote：这不是改写，是照抄，直接丢掉。
    if (quote.length >= QUOTE_ECHO_MIN_CHARS && normalizeForMatch(query).includes(quote)) continue;
    if (!out.includes(query)) out.push(query);
    if (out.length >= perFact) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 事实取样
// ---------------------------------------------------------------------------

/**
 * 读取可用于评测的 active 事实。
 * 缺 evidence_session / evidence_seq 的无法构造 expect，直接跳过（不计入 limit）。
 * @param {object} db
 * @param {{limit?: number}} [options]
 * @returns {{facts: object[], active: number, eligible: number,
 *   skippedNoEvidence: number, skippedNoContent: number}}
 */
export function loadActiveFacts(db, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit >= 0
    ? Math.trunc(options.limit)
    : Infinity;

  let rows;
  try {
    rows = db.prepare(`
      SELECT id, key, value, scope, kind, status, quote, note,
             evidence_session, evidence_seq, created_at
      FROM facts
      WHERE status = 'active'
      ORDER BY created_at DESC, rowid DESC
    `).all();
  } catch (error) {
    throw new Error(`读取 facts 失败：${error.message}`);
  }

  const eligible = [];
  let skippedNoEvidence = 0;
  let skippedNoContent = 0;
  for (const row of rows) {
    const sessionId = typeof row.evidence_session === 'string' ? row.evidence_session.trim() : '';
    const seq = Number(row.evidence_seq);
    if (!sessionId || row.evidence_seq === null || row.evidence_seq === undefined
      || !Number.isFinite(seq)) {
      skippedNoEvidence += 1;
      continue;
    }
    // key 之外没有任何内容（value/quote/note 全空）的事实没法生成有意义的问题。
    if (!nonEmpty(row.value) && !nonEmpty(row.quote) && !nonEmpty(row.note)) {
      skippedNoContent += 1;
      continue;
    }
    eligible.push({ ...row, evidence_session: sessionId, evidence_seq: Math.trunc(seq) });
  }

  return {
    facts: eligible.slice(0, limit),
    active: rows.length,
    eligible: eligible.length,
    skippedNoEvidence,
    skippedNoContent,
  };
}

// ---------------------------------------------------------------------------
// 幂等追加
// ---------------------------------------------------------------------------

function rowKey(factId, query) {
  return `${factId ?? ''}\u0000${query ?? ''}`;
}

function readExistingState(file) {
  const state = { keys: new Set(), rows: 0, size: 0, endsWithNewline: true };
  if (!file || !fs.existsSync(file)) return state;
  const text = fs.readFileSync(file, 'utf8');
  state.size = Buffer.byteLength(text);
  state.endsWithNewline = text.length === 0 || text.endsWith('\n');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    state.rows += 1;
    try {
      const parsed = JSON.parse(line);
      state.keys.add(rowKey(parsed?.fact_id, parsed?.query));
    } catch {
      // 坏行不改写，也不阻塞追加；它不参与去重。
    }
  }
  return state;
}

function appendRows(file, rows, state) {
  if (!rows.length) return;
  const text = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const prefix = state.size > 0 && !state.endsWithNewline ? '\n' : '';
  fs.appendFileSync(file, prefix + text, 'utf8');
  state.size += Buffer.byteLength(prefix + text);
  state.endsWithNewline = true;
  state.rows += rows.length;
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/** 失败重试 1 次（立即重试；HTTP 层的退避由 chatJson 自己处理）。 */
const RETRIES = 1;

/**
 * 为一条事实生成问题。失败（调用抛错 / JSON 坏了）重试一次，仍失败返回 error。
 * 模型返回空数组不算失败。
 * @param {object} fact
 * @param {{complete: Function, perFact: number, retries?: number}} options
 * @returns {Promise<{queries: string[], error: Error|null}>}
 */
export async function generateForFact(fact, options = {}) {
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new TypeError('generateForFact: 需要 complete 函数');
  }
  const perFact = Number.isFinite(options.perFact) && options.perFact >= 1
    ? Math.trunc(options.perFact)
    : 1;
  const retries = Number.isFinite(options.retries) && options.retries >= 0
    ? Math.trunc(options.retries)
    : RETRIES;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const raw = await complete(buildQueryMessages(fact, perFact));
      const parsed = parseGeneratedQueries(raw);
      return { queries: filterQueries(parsed, fact, perFact), error: null };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  return { queries: [], error: lastError };
}

function normalizeCount(value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null || value === false) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.trunc(parsed);
}

/**
 * 批量生成 + 幂等追加。
 *
 * @param {object} db
 * @param {{
 *   out?: string|null,
 *   limit?: number,
 *   perFact?: number,
 *   complete: Function,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{
 *   sampled: number, active: number, eligible: number,
 *   skippedNoEvidence: number, skippedNoContent: number,
 *   success: number, failed: number, empty: number,
 *   produced: number, written: number, duplicated: number, rows: object[]
 * }>}
 */
export async function generateQueries(db, options = {}) {
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new TypeError('generateQueries: 需要 complete 函数');
  }
  const limit = normalizeCount(options.limit, DEFAULTS.limit, { min: 0 });
  const perFact = normalizeCount(options.perFact, DEFAULTS.perFact, { min: 1 });
  const log = typeof options.log === 'function' ? options.log : () => {};
  const out = nonEmpty(options.out) ? path.resolve(expandHome(String(options.out))) : null;
  if (out) fs.mkdirSync(path.dirname(out), { recursive: true });

  const loaded = loadActiveFacts(db, { limit });
  const state = out ? readExistingState(out) : { keys: new Set(), rows: 0, size: 0, endsWithNewline: true };

  const stats = {
    sampled: loaded.facts.length,
    active: loaded.active,
    eligible: loaded.eligible,
    skippedNoEvidence: loaded.skippedNoEvidence,
    skippedNoContent: loaded.skippedNoContent,
    success: 0,
    failed: 0,
    empty: 0,
    produced: 0,
    written: 0,
    duplicated: 0,
    rows: [],
  };

  for (let index = 0; index < loaded.facts.length; index += 1) {
    const fact = loaded.facts[index];
    const position = `${index + 1}/${loaded.facts.length}`;
    const result = await generateForFact(fact, { complete, perFact });

    if (result.error) {
      stats.failed += 1;
      log(`[gen-queries] ${position} ${fact.key} 失败：${redactSecrets(result.error.message)}（已跳过）`);
      continue;
    }

    stats.success += 1;
    if (result.queries.length === 0) stats.empty += 1;
    stats.produced += result.queries.length;

    const rows = result.queries.map((query) => ({
      query,
      scope: nonEmpty(fact.scope) ? fact.scope : 'global',
      expect: { session_id: fact.evidence_session, seq: fact.evidence_seq },
      fact_id: fact.id,
      source: 'llm',
    }));
    stats.rows.push(...rows);

    let fresh = rows;
    if (out) {
      fresh = [];
      for (const row of rows) {
        const key = rowKey(row.fact_id, row.query);
        if (state.keys.has(key)) {
          stats.duplicated += 1;
          continue;
        }
        state.keys.add(key);
        fresh.push(row);
      }
      appendRows(out, fresh, state);
    }
    stats.written += fresh.length;
    log(`[gen-queries] ${position} ${fact.key} → ${result.queries.length} 问`);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function requireStringFlag(flags, name) {
  const value = flags[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`--${name} 需要一个非空值`);
  }
  return value;
}

function parseIntegerFlag(flags, name, fallback, min) {
  const value = flags[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`--${name} 必须是 >= ${min} 的整数，收到：${value}`);
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const dbPath = path.resolve(expandHome(requireStringFlag(flags, 'db') ?? DEFAULTS.db));
  const outPath = path.resolve(expandHome(requireStringFlag(flags, 'out') ?? DEFAULTS.out));
  const limit = parseIntegerFlag(flags, 'limit', DEFAULTS.limit, 0);
  const perFact = parseIntegerFlag(flags, 'per-fact', DEFAULTS.perFact, 1);

  if (!fs.existsSync(dbPath)) {
    console.error(
      `[gen-queries] 数据库不存在：${dbPath}\n`
        + `[gen-queries] 先跑：node scripts/extract.mjs --db ${dbPath} --root .data/sessions-copy`,
    );
    process.exitCode = 1;
    return;
  }

  // 凭据只到这里为止：config.apiKey 不打印、不落盘。
  const config = resolveLlmConfig();
  if (!config.available) {
    console.log('未配置模型凭据，跳过查询生成');
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  console.log(
    `[gen-queries] db=${dbPath} out=${outPath} model=${config.model}`
      + ` limit=${limit} per-fact=${perFact}`,
  );

  const db = openDb(dbPath);
  try {
    const stats = await generateQueries(db, {
      out: outPath,
      limit,
      perFact,
      complete: async (messages) => chatJson({
        messages,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
      }),
      log: (line) => console.log(line),
    });

    console.log(
      `[gen-queries] active 事实 ${stats.active} · 可评测 ${stats.eligible}`
        + ` · 本次取样 ${stats.sampled}`
        + `（缺 evidence 跳过 ${stats.skippedNoEvidence}`
        + `${stats.skippedNoContent ? ` / 无内容跳过 ${stats.skippedNoContent}` : ''}）`,
    );
    const rate = stats.sampled > 0
      ? `${((stats.success / stats.sampled) * 100).toFixed(1)}%`
      : 'n/a';
    console.log(
      `[gen-queries] 成功 ${stats.success}/${stats.sampled} (${rate})`
        + ` · 失败 ${stats.failed}`
        + `${stats.empty ? ` · 空结果 ${stats.empty}` : ''}`
        + ` · 生成 ${stats.produced} 问`
        + ` · 新增 ${stats.written} 行`
        + ` · 重复跳过 ${stats.duplicated}`,
    );
  } finally {
    db.close();
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`[gen-queries] 失败：${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}

export default {
  buildQueryMessages,
  parseGeneratedQueries,
  filterQueries,
  loadActiveFacts,
  generateForFact,
  generateQueries,
  main,
};
