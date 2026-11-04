/**
 * 读取路径 · 召回 + 打分 + 折叠 + 邻域
 *
 * 契约见 docs/design.md 第 4 节（签名冻结）：
 *   search(db, { query, scope, limit, includeSuperseded }) → Hit[]
 *   foldVersions(db, hits) → Hit[]
 *   neighbors(db, hit, { before, after }) → Neighbor[]
 *
 * Hit: { unit, event, session, fact?, score, reasons[] }
 *
 * 设计取舍：
 * - 不排除 `u.surface IS NULL` 的行：被压缩掉（shadowed）的原文往往正是
 *   "当时发生了什么"的唯一证据，压掉它等于丢证据。surface 只在打分里加权。
 * - bm25 只用于粗排（SQL 里 ORDER BY + LIMIT limit*4），最终顺序由
 *   可解释的合成分数决定，并在 reasons 里写清楚每一项的来源。
 */

import { ftsPhrase } from './chunk.js';

const DAY_MS = 86_400_000;

/** 时间衰减半衰期：30 天前的内容权重减半。 */
const HALF_LIFE_DAYS = 30;

/** 先按 bm25 粗排 limit*4 条，再按合成分数精排，避免把好证据卡在 SQL 的 LIMIT 之外。 */
const CANDIDATE_FACTOR = 4;

/** bigram 回退的候选池下限：覆盖率重排需要足够的候选，limit 很小时也不能太浅。 */
const BIGRAM_MIN_CAP = 32;

/** OR 回退时最多取多少个 token，防止超长 query 生成过大的 FTS 表达式。 */
const MAX_FALLBACK_TOKENS = 12;

/** 中文 bigram OR 的上限，避免长句生成过大的 FTS 表达式。 */
const MAX_BIGRAMS = 16;

/**
 * 停用字：由两个停用字组成的 bigram 没有区分度（「哪个」「用哪」），
 * 参与 OR 只会带进噪音，直接丢掉。
 */
const STOP_CHARS = new Set('的了是在有和与就都也很我你他这那个用哪什么吗呢吧啊呀'.split(''));

/** 连续中文段（含扩展 A 与兼容区）。 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** 拉丁词：独立于空白分词，`pnpm用哪个` 这种粘连也能抠出 pnpm。 */
const LATIN_WORD = /[A-Za-z][A-Za-z0-9._-]*/g;

/**
 * 作者权重（乘子）：用户亲口说的最接近「决策 / 偏好」，工具输出最接近噪音。
 * 未知作者按 1.0（中性）处理。
 */
const AUTHOR_WEIGHT = Object.freeze({
  user: 1.2,
  assistant: 1.0,
  tool: 0.8,
  system: 0.9,
});

/**
 * surface 加成（绝对值，不是乘子）：
 *   current  = 未压缩的当前原文，+0.10
 *   shadowed = 被压缩掉的旧版本，−0.05
 *   log-only = 只在日志里、模型当时没看到，0
 *   NULL     = 按 log-only 处理
 */
const SURFACE_DELTA = Object.freeze({
  current: 0.1,
  shadowed: -0.05,
  'log-only': 0,
});

/** 命中 facts.quote 的奖励：这条 unit 本身就是某条事实的证据。 */
const FACT_BONUS = 0.15;

/**
 * bigram 覆盖率加成权重：coverage = 命中 bigram 数 / query bigram 总数。
 * 目的：中文自然语言问句走 bigram 回退时，避免「只命中一个常见 bigram 的超短 unit」
 * 靠 bm25 的长度归一化压过「命中多个 bigram 的长 unit」。
 * 只加在 bigram 回退模式；整句 phrase 命中的 coverage 视为 1.0 但不加分。
 *
 * 权重标定（真实库 facts2.db / scope=agent_search）：
 *   3/8 覆盖的 815 字 unit  bm25 基分 0.400
 *   1/8 覆盖的 15 字 unit   bm25 基分 0.484（bm25 长度归一化把短 unit 抬高了 0.084）
 *   0.25 权重只能拉开 0.25*(3/8-1/8)=0.0625，仍压不住 → 用 0.4 拉开 0.1，留 0.016 余量。
 * 想回退到 0.25 只改这一个常量即可。
 */
const COVERAGE_WEIGHT = 0.4;

/** 分词用的分隔符：空白 + 中英文标点。仅在整句 phrase 查不到时才用。 */
const TOKEN_SEP =
  /[\s\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65,.;:!?()[\]{}<>"'`~@#$%^&*+=|\\/-]+/u;

/** 事实状态的优先级：越高越优先挂到 hit 上。 */
const FACT_STATUS_RANK = Object.freeze({
  active: 3,
  disputed: 2,
  superseded: 1,
  archived: 0,
});

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAuthor(author) {
  const a = String(author ?? '').toLowerCase();
  if (a === 'agent') return 'assistant';
  if (a === 'human') return 'user';
  return a || 'assistant';
}

/**
 * bm25 原始值是负数，**越负越相关**（FTS5: smaller = better match）。
 * 归一化必须保序：|rank| 越大 → 越接近 1。
 * 注意别写成 1/(1+|rank|)——那会把最相关的排到最后。
 */
function normalizeBm25(rank) {
  if (!Number.isFinite(rank)) return 0.5;
  const magnitude = Math.abs(rank);
  return magnitude / (1 + magnitude);
}

/** 指数衰减，半衰期 HALF_LIFE_DAYS 天。未来时间戳不做放大（按 1 处理）。 */
function timeDecay(timeMs, now) {
  if (!Number.isFinite(timeMs)) return 0.5; // 没有时间信息：给中性值，不偏向新旧
  const age = Math.max(0, now - timeMs);
  return Math.pow(0.5, age / DAY_MS / HALF_LIFE_DAYS);
}

/**
 * 调 chunk.js 的 ftsPhrase；万一它抛错或返回空，退回到最小可用的加引号转义，
 * 保证 search 不会因为查询构造而整条链路失败。
 */
function safeFtsPhrase(term) {
  const raw = String(term ?? '').trim();
  if (!raw) return '';
  try {
    const out = ftsPhrase(raw);
    if (typeof out === 'string' && out.trim()) return out.trim();
  } catch {
    /* 落到下面的兜底 */
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

/** query → 去重后的词列表（按原文顺序）。 */
export function tokenizeQuery(query) {
  const seen = new Set();
  const out = [];
  for (const piece of String(query ?? '').split(TOKEN_SEP)) {
    const token = piece.trim();
    if (!token || token.length > 64 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_FALLBACK_TOKENS) break;
  }
  return out;
}

/**
 * 中文 bigram：对每个连续中文段做长度 2 的滑动窗口。
 * 「包管理器用哪个」→ 包管 / 管理 / 理器 / 器用 / 用哪 / 哪个（去重、保序）。
 * 这是自然语言问句唯一的召回路子：unicode61 按整词切，整句 phrase 在原文里不存在。
 */
export function extractCjkBigrams(query) {
  const seen = new Set();
  const out = [];
  for (const run of String(query ?? '').match(CJK_RUN) ?? []) {
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

/** 两个字符都是停用字 → 这个 bigram 没有检索价值。 */
function isStopwordGram(gram) {
  return STOP_CHARS.has(gram[0]) && STOP_CHARS.has(gram[1]);
}

/** 抽拉丁词（去重，忽略单字母，避免 OR 过宽）。 */
export function extractLatinTokens(query) {
  const seen = new Set();
  const out = [];
  for (const word of String(query ?? '').match(LATIN_WORD) ?? []) {
    const lower = word.toLowerCase();
    if (word.length < 2 || seen.has(lower)) continue;
    seen.add(lower);
    out.push(word);
    if (out.length >= MAX_FALLBACK_TOKENS) break;
  }
  return out;
}

/**
 * 查询构造（design 第 7 节），按精确度降序尝试，前一级命中就不往下走：
 *   1) 整句 phrase —— 原文逐字出现，最精确
 *   2) 中文 bigram OR（混入拉丁词）—— 自然语言问句的兜底
 *   3) 按空白/标点切 token 后 OR —— 最后兜底
 *
 * 返回 { attempts: [{ kind, expr }], bigrams }；bigrams 用于把命中数写进 reasons。
 */
export function buildQueryPlan(query) {
  const q = String(query ?? '').trim();
  const attempts = [];
  const phrase = safeFtsPhrase(q);
  if (phrase) attempts.push({ kind: 'phrase', expr: phrase });

  const bigrams = extractCjkBigrams(q);
  if (bigrams.length) {
    const kept = bigrams.filter((gram) => !isStopwordGram(gram)).slice(0, MAX_BIGRAMS);
    const parts = [
      ...extractLatinTokens(q).map((word) => safeFtsPhrase(word)),
      ...kept.map((gram) => safeFtsPhrase(gram)),
    ].filter(Boolean);
    const expr = [...new Set(parts)].join(' OR ');
    // 两个字的纯中文词（「测试」）的 bigram 表达式与整句 phrase 相同，不必重试。
    if (expr && expr !== phrase && !attempts.some((a) => a.expr === expr)) {
      attempts.push({ kind: 'bigram', expr });
    }
  }

  const tokenParts = tokenizeQuery(q).map((token) => safeFtsPhrase(token)).filter(Boolean);
  if (tokenParts.length > 1) {
    const expr = [...new Set(tokenParts)].join(' OR ');
    if (!attempts.some((a) => a.expr === expr)) attempts.push({ kind: 'token', expr });
  }

  return { attempts, bigrams };
}

/** 兼容旧接口：只返回 FTS 表达式列表。 */
export function buildMatchExpressions(query) {
  return buildQueryPlan(query).attempts.map((attempt) => attempt.expr);
}

// ---------------------------------------------------------------------------
// 候选查询
// ---------------------------------------------------------------------------

function candidateSql(hasScopeFilter) {
  const where = ['unit_fts MATCH ?'];
  if (hasScopeFilter) where.push('s.cwd = ?');
  return `
    SELECT
      u.id, u.session_id, u.seq, u.start, u.end, u.text, u.time, u.author, u.surface,
      s.cwd AS session_cwd, s.path AS session_path, s.created_at AS session_created_at,
      s.parent_id AS session_parent_id, s.origin AS session_origin,
      e.type AS event_type, e.time AS event_time, e.surface AS event_surface,
      e.author AS event_author, e.text AS event_text,
      bm25(unit_fts) AS rank
    FROM unit_fts
    JOIN units u ON u.id = unit_fts.unit_id
    JOIN sessions s ON s.id = u.session_id
    LEFT JOIN events e ON e.session_id = u.session_id AND e.seq = u.seq
    WHERE ${where.join(' AND ')}
    ORDER BY bm25(unit_fts)
    LIMIT ?`;
}

/**
 * 只有 scope 不是 'global' 时才按 cwd 过滤；global 表示「不限定项目」。
 * scope 为空按 global 处理。
 */
function normalizeScope(scope) {
  const s = String(scope ?? '').trim();
  return s || 'global';
}

function runQuery(db, match, scope, cap) {
  const scoped = scope !== 'global';
  const sql = candidateSql(scoped);
  const params = scoped ? [match, scope, cap] : [match, cap];
  return db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// 事实匹配（facts.quote → unit.text）
// ---------------------------------------------------------------------------

/**
 * 取出可用于匹配的 facts：本 scope 的 + 全局的。
 * 包含 superseded —— 默认检索要能识别「这条证据已经过期」，否则无法判断丢弃。
 */
function loadFacts(db, scope) {
  let sql = 'SELECT * FROM facts WHERE scope = ?';
  const params = [scope];
  if (scope !== 'global') {
    sql = "SELECT * FROM facts WHERE scope = ? OR scope = 'global'";
  }
  sql += ' ORDER BY created_at ASC';
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

/** 一条 unit 命中了 query 里多少个中文 bigram（分母是生成总数，调试用）。 */
function countBigrams(text, bigrams) {
  if (!bigrams.length) return 0;
  const hay = collapse(text);
  if (!hay) return 0;
  let hit = 0;
  for (const gram of bigrams) if (hay.includes(gram)) hit += 1;
  return hit;
}

/** 在 unit 文本里找 facts.quote；优先 active，其次引文更长（更具体）的。 */
function matchFact(unitText, facts) {
  const hay = collapse(unitText).toLowerCase();
  if (!hay || !facts.length) return null;
  let best = null;
  let bestRank = -1;
  let bestLen = 0;
  for (const fact of facts) {
    const quote = collapse(fact.quote);
    if (quote.length < 2) continue;
    if (!hay.includes(quote.toLowerCase())) continue;
    const rank = FACT_STATUS_RANK[fact.status] ?? 0;
    const len = quote.length;
    if (rank > bestRank || (rank === bestRank && len > bestLen)) {
      best = fact;
      bestRank = rank;
      bestLen = len;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 检索单元。
 *
 * @param {object} db  openDb() 返回的 DatabaseSync
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.scope='global']
 * @param {number} [opts.limit=8]
 * @param {boolean} [opts.includeSuperseded=false] 是否返回落在已废弃事实上的证据
 * @param {number} [opts.now=Date.now()] 注入时钟（测试用）
 * @returns {Array<{unit:object,event:object|null,session:object,fact?:object,score:number,reasons:string[]}>}
 */
export function search(db, opts = {}) {
  const query = String(opts.query ?? '').trim();
  if (!query) return [];

  const scope = normalizeScope(opts.scope);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 8;
  const includeSuperseded = Boolean(opts.includeSuperseded);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const baseCap = Math.max(limit * CANDIDATE_FACTOR, limit);

  const plan = buildQueryPlan(query);
  if (!plan.attempts.length) return [];

  const facts = loadFacts(db, scope);

  let rows = [];
  let lastError = null;
  let matchedKind = null;
  for (const attempt of plan.attempts) {
    // bigram 回退要按覆盖率重排，候选池太浅会把「bm25 排名不占优但覆盖率高」的长 unit
    // 挡在池外（limit=3 时 cap 只有 12）。所以这类尝试至少取 32 条；phrase 模式不变。
    const cap = attempt.kind === 'bigram' ? Math.max(baseCap, BIGRAM_MIN_CAP) : baseCap;
    try {
      rows = runQuery(db, attempt.expr, scope, cap);
      lastError = null;
    } catch (err) {
      // FTS 语法错误：记下，继续试下一种构造；全部炸掉再抛，避免吞掉真 bug。
      lastError = err;
      rows = [];
    }
    if (rows.length) {
      matchedKind = attempt.kind;
      break;
    }
  }
  if (lastError && !rows.length) throw lastError;
  if (!rows.length) return [];

  const hits = [];
  for (const row of rows) {
    const unit = {
      id: row.id,
      session_id: row.session_id,
      seq: row.seq,
      start: row.start,
      end: row.end,
      text: row.text,
      time: row.time,
      author: row.author,
      surface: row.surface,
    };
    const event =
      row.event_type == null
        ? null
        : {
            session_id: row.session_id,
            seq: row.seq,
            type: row.event_type,
            time: row.event_time,
            surface: row.event_surface,
            author: row.event_author,
            text: row.event_text,
          };
    const session = {
      id: row.session_id,
      cwd: row.session_cwd,
      path: row.session_path,
      created_at: row.session_created_at,
      parent_id: row.session_parent_id,
      origin: row.session_origin,
    };

    const fact = matchFact(unit.text, facts) ?? undefined;
    // 「active only」：落在已废弃事实上的证据默认不返回；除非调用方显式要。
    if (fact && !includeSuperseded && (fact.status === 'superseded' || fact.status === 'archived')) {
      continue;
    }

    const author = normalizeAuthor(unit.author ?? event?.author);
    const authorWeight = AUTHOR_WEIGHT[author] ?? 1.0;
    const surface = unit.surface ?? event?.surface ?? 'log-only';
    const surfaceDelta = SURFACE_DELTA[surface] ?? 0;
    const timeMs = unit.time ?? event?.time ?? session.created_at ?? null;
    const decay = timeDecay(timeMs, now);
    const bm25Norm = normalizeBm25(row.rank);

    // bigram 覆盖率：分子是本条 unit 命中的 bigram 数，分母是 query 的 bigram 总数。
    const totalBigrams = plan.bigrams.length;
    const hitBigrams = totalBigrams ? countBigrams(unit.text, plan.bigrams) : 0;
    // 整句 phrase 命中 = 原文逐字出现，视为满覆盖（但只有 bigram 回退才计入分数）。
    const coverage = matchedKind === 'phrase' ? 1 : totalBigrams ? hitBigrams / totalBigrams : 0;

    // 合成分数：相关性 bm25 × 时间衰减 × 作者权重，再叠加 surface / fact / 覆盖率的绝对加成。
    // 乘法项保证「又相关又新鲜又来自用户」的内容排最前；绝对项只做微调。
    let score = bm25Norm * decay * authorWeight;
    score += surfaceDelta;
    if (fact) score += FACT_BONUS;
    if (matchedKind === 'bigram') score += COVERAGE_WEIGHT * coverage;

    const reasons = [
      `bm25=${bm25Norm.toFixed(2)}`,
      timeMs == null
        ? 'age=?'
        : `age=${Math.max(0, Math.round((now - timeMs) / DAY_MS))}d`,
      `author=${author}×${authorWeight.toFixed(1)}`,
      `surface=${surface}${surfaceDelta ? (surfaceDelta > 0 ? '+' : '') + surfaceDelta.toFixed(2) : ''}`,
    ];
    if (fact) reasons.push(`quote+0.15:${fact.key}${fact.status === 'active' ? '' : `(${fact.status})`}`);
    if (includeSuperseded) reasons.push('includeSuperseded');
    // 调试用：bigram 命中数（分子/query bigram 总数）与覆盖率，两者并列。
    if (totalBigrams) {
      reasons.push(`bigram:${hitBigrams}/${totalBigrams}`);
      reasons.push(`coverage:${coverage.toFixed(3)}`);
    }
    if (matchedKind === 'bigram') reasons.push('bigram-fallback');
    else if (matchedKind === 'token') reasons.push('or-fallback');

    hits.push({ unit, event, session, fact, score, reasons });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * 折叠重复版本：
 *   1) 同一 (session_id, seq) 的多个 unit（分块）只留分数最高的
 *   2) 文本高度重叠（去空白后前 40 字符相同）的只留一条
 * 结果按分数降序；JS sort 稳定，同分保留原相对顺序。
 *
 * @param {object} db   保留参数（签名冻结）；同一 key 多版本的折叠由
 *                      facts.status + includeSuperseded 负责，这里不重复做。
 * @param {Array} hits
 */
export function foldVersions(db, hits = []) {
  const sorted = [...(hits ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seenSeq = new Set();
  const seenPrefix = new Set();
  const out = [];

  for (const hit of sorted) {
    const unit = hit?.unit ?? {};
    const sessionId = unit.session_id ?? hit?.session?.id ?? '';
    const seq = unit.seq ?? hit?.event?.seq ?? '';

    const seqKey = `${sessionId}#${seq}`;
    if (seenSeq.has(seqKey)) continue;

    const prefix = collapse(unit.text ?? hit?.event?.text).slice(0, 40);
    if (prefix && seenPrefix.has(prefix)) continue;

    seenSeq.add(seqKey);
    if (prefix) seenPrefix.add(prefix);
    out.push(hit);
  }

  return out;
}

/**
 * 邻域：取同一 session 中 seq 相邻的事件文本，用于给命中附上下文。
 * 注意 events.seq 不保证连续（压缩会留空洞），所以按 seq 区间查而不是 seq±1 取值。
 *
 * @returns {Array<{seq:number, direction:'before'|'after', type:string|null,
 *                  author:string|null, surface:string|null, time:number|null, text:string}>}
 */
export function neighbors(db, hit, opts = {}) {
  const before = Number.isFinite(opts.before) ? Math.max(0, Math.floor(opts.before)) : 1;
  const after = Number.isFinite(opts.after) ? Math.max(0, Math.floor(opts.after)) : 1;
  if (!hit || (!before && !after)) return [];

  const sessionId = hit?.unit?.session_id ?? hit?.session?.id ?? hit?.event?.session_id;
  const seq = Number(hit?.unit?.seq ?? hit?.event?.seq);
  if (!sessionId || !Number.isFinite(seq)) return [];

  const sql = `
    SELECT seq, type, time, surface, author, text
    FROM events
    WHERE session_id = ?
      AND seq BETWEEN ? AND ?
      AND seq <> ?
      AND text IS NOT NULL
      AND text <> ''
    ORDER BY seq ASC`;
  let rows = [];
  try {
    rows = db.prepare(sql).all(sessionId, seq - before, seq + after, seq);
  } catch {
    return [];
  }

  return rows.map((row) => ({
    seq: row.seq,
    direction: row.seq < seq ? 'before' : 'after',
    type: row.type ?? null,
    author: row.author ?? null,
    surface: row.surface ?? null,
    time: row.time ?? null,
    text: row.text,
  }));
}
