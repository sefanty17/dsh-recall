/**
 * 读取路径 · 纯文本格式化
 *
 * 这些字符串就是模型实际看到的内容，所以：
 * - 时间统一 `YYYY-MM-DD HH:mm`（state / history 用日期即可，见 design 第 5 节）
 * - 宽字段用空格对齐，中文 / emoji 按 2 字符宽计算
 * - 引文超过 60 字截断加 `…`
 * - 没有下一个动作就不加 `→` 提示
 *
 * 接口冻结（design 第 4 节）：
 *   formatHit(hit, ctx) / formatState(facts, ctx) /
 *   formatSearchResult(hits, meta) / formatHistory(facts, ctx)
 *
 * 说明：facts 行可能来自 facts.js，字段命名按 design 的 DDL 为 snake_case；
 * 这里用 field() 兼容 camelCase，避免跨模块命名差异把格式化打崩。
 */

/** 引文截断长度（字符，不是显示宽度）。 */
const QUOTE_MAX = 60;
/** 状态表 / 历史表里 value 列的截断长度。 */
const VALUE_MAX = 36;

// ---------------------------------------------------------------------------
// 宽度与对齐
// ---------------------------------------------------------------------------

/**
 * East Asian Width = W/F 的区间 + emoji。用于把中文按 2 格算。
 * 覆盖：CJK 部首/汉字/兼容汉字、假名、谚文、全角标点、常见 emoji。
 */
const WIDE_CHAR =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f000}-\u{1faff}\u2700-\u27bf\u2b00-\u2bff]/u;

function charWidth(ch) {
  return WIDE_CHAR.test(ch) ? 2 : 1;
}

/** 显示宽度：中文 / emoji 记 2。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) width += charWidth(ch);
  return width;
}

/** 右补空格到指定显示宽度（已超宽则原样返回）。 */
export function padRight(text, width) {
  const s = String(text ?? '');
  const pad = Math.max(0, width - displayWidth(s));
  return s + ' '.repeat(pad);
}

/** 折行 / 多空白压成单行。 */
export function collapse(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按字符截断，超长补 `…`。 */
export function truncate(text, max = QUOTE_MAX) {
  const chars = [...collapse(text)];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

/**
 * 按显示宽度截断：中文/emoji 占 2 格，保证截断后列宽不被撑破。
 * 比 truncate 更适合表格列。
 */
export function fitWidth(text, width) {
  const s = String(text ?? '');
  if (displayWidth(s) <= width) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

const p2 = (n) => String(n).padStart(2, '0');

/** null / undefined / 空串 / 非数字一律视为「没有时间」，不要退化成 1970。 */
function toTimeMs(ms) {
  if (ms === null || ms === undefined || ms === '') return NaN;
  const n = Number(ms);
  return Number.isFinite(n) ? n : NaN;
}

/** `YYYY-MM-DD`（本地时区）。时间缺失给占位符，保证列对齐。 */
export function formatDay(ms) {
  const n = toTimeMs(ms);
  if (Number.isNaN(n)) return '????-??-??';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** `YYYY-MM-DD HH:mm`（本地时区）。 */
export function formatTime(ms) {
  const n = toTimeMs(ms);
  if (Number.isNaN(n)) return '????-??-?? ??:??';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '????-??-?? ??:??';
  return `${formatDay(n)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * session id 的短形式：前 18 位 + `…`。仅用于展示。
 * 真实 id 有两种形态：`ed3e1da7-a088-…` 和 `session-a3b6757f-…`；
 * 只留 6 位会变成 `sessio…` / `ed3e1d…`，既无法辨认也无法拿去调工具。
 */
export function shortId(id, keep = 18) {
  const s = String(id ?? '');
  if (!s) return '?';
  return s.length > keep ? `${s.slice(0, keep)}…` : s;
}

// ---------------------------------------------------------------------------
// facts 行字段兼容
// ---------------------------------------------------------------------------

function field(row, ...names) {
  if (!row) return undefined;
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

const factKey = (f) => String(field(f, 'key') ?? '?');
const factStatus = (f) => String(field(f, 'status') ?? 'active');
const factAuthor = (f) => String(field(f, 'author') ?? 'rule');
const factSince = (f) => field(f, 'since', 'created_at', 'createdAt');
const factQuote = (f) => field(f, 'quote');
const factSeq = (f) => field(f, 'evidence_seq', 'evidenceSeq');

/** value 优先，其次引文，最后是 note。 */
function factValue(f) {
  const v = field(f, 'value');
  if (v != null && String(v).trim()) return collapse(v);
  const q = factQuote(f);
  if (q != null && String(q).trim()) return collapse(q);
  const n = field(f, 'note');
  if (n != null && String(n).trim()) return collapse(n);
  return '-';
}

const factEvidence = (f) => {
  const seq = factSeq(f);
  return seq == null || seq === '' ? '—' : `e${seq}`;
};

/** 负向事实的标记：key / value 里出现"不要用 / never / 禁止"这类词。 */
const NEGATIVE = /\bnever\b|\bno-|\bavoid\b|\bdon'?t\b|不要|禁止|避免|别用/i;

function keyMarker(f) {
  const status = factStatus(f);
  if (status === 'disputed') return '⚠';
  if (status === 'superseded' || status === 'archived') return '⊘';
  if (NEGATIVE.test(factKey(f)) || NEGATIVE.test(factValue(f))) return '❌';
  return '';
}

function columnWidth(rows, getter, min, max) {
  let width = min;
  for (const row of rows) width = Math.max(width, displayWidth(getter(row)));
  return Math.min(width, max);
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

/**
 * 一条命中的自足单元。ctx: { index?, neighbors?, maxQuote? }
 * 不传 index 时不加序号（单独引用一条命中时用）。
 */
export function formatHit(hit, ctx = {}) {
  const fact = hit?.fact;
  const unit = hit?.unit ?? {};

  const kind = field(fact, 'kind') ?? 'evidence';
  const timeMs = factSince(fact) ?? unit.time ?? hit?.event?.time ?? hit?.session?.created_at;
  const author = fact ? factAuthor(fact) : String(unit.author ?? hit?.event?.author ?? 'unknown');
  const status = fact ? factStatus(fact) : 'active';
  const statusNote = status && status !== 'active' ? ` · ${status}` : '';

  const rawText = factQuote(fact) ?? unit.text ?? hit?.event?.text ?? '';
  const quote = truncate(rawText, Number.isFinite(ctx.maxQuote) ? ctx.maxQuote : QUOTE_MAX);

  const prefix = Number.isInteger(ctx.index) ? `${ctx.index + 1}. ` : '';
  const lines = [
    `${prefix}[${kind}] ${formatTime(timeMs)} · ${author}${statusNote}`,
    `   "${quote}"`,
  ];

  const sessionId = hit?.session?.id ?? unit.session_id ?? hit?.event?.session_id ?? field(fact, 'evidence_session', 'evidenceSession');
  const seq = unit.seq ?? hit?.event?.seq ?? factSeq(fact);
  if (sessionId && seq != null) {
    const span =
      unit.start != null && unit.end != null ? ` [${unit.start},${unit.end}]` : '';
    lines.push(`   ↳ session ${shortId(sessionId)} seq ${seq}${span}`);
  }

  const near = Array.isArray(ctx.neighbors) ? ctx.neighbors : Array.isArray(hit?.neighbors) ? hit.neighbors : [];
  for (const nb of near.slice(0, 2)) {
    // 带方向的行内标签：`↳ 前一条：…` / `↳ 后一条：…`，每条 60 字以内。
    const label = nb?.direction === 'after' ? '后一条' : '前一条';
    lines.push(`   ↳ ${label}：${truncate(nb?.text, 60)}`);
  }

  return lines.join('\n');
}

/**
 * 状态表。ctx: { scope, all? }
 * 默认只列 active（"6 active facts" 必须名副其实）。
 */
export function formatState(facts = [], ctx = {}) {
  const all = Boolean(ctx.all);
  const scope = String(ctx.scope ?? 'global');
  const rows = (Array.isArray(facts) ? facts : [])
    .filter((f) => all || factStatus(f) === 'active')
    .sort((a, b) => factKey(a).localeCompare(factKey(b)));

  const header = all
    ? `[memory.state] scope=${scope} · ${rows.length} facts (incl. inactive)`
    : `[memory.state] scope=${scope} · ${rows.length} active facts`;
  const lines = [header];

  if (!rows.length) {
    lines.push('（没有结构化约定；用 memory(action="search") 查历史，或用 memory(action="write") 记录）');
    return lines.join('\n');
  }

  const keyTexts = rows.map((f) => `${keyMarker(f)}${factKey(f)}`);
  const valueTexts = rows.map((f) => truncate(factValue(f), VALUE_MAX));
  const keyWidth = columnWidth(keyTexts, (t) => t, 12, 26);
  const valueWidth = columnWidth(valueTexts, (t) => t, 8, 24);

  rows.forEach((f, i) => {
    lines.push(
      `${padRight(fitWidth(keyTexts[i], keyWidth), keyWidth)} = ` +
        `${padRight(fitWidth(valueTexts[i], valueWidth), valueWidth)} ` +
        `${formatDay(factSince(f))}  ${padRight(factAuthor(f), 6)} ${factEvidence(f)}`,
    );
  });

  lines.push(`→ 看某个键的演变：memory(action="history", key="${factKey(rows[0])}")`);
  return lines.join('\n');
}

/**
 * 历史表。ctx: { key, scope }
 * 按 since 升序；active 用大写 ACTIVE 标出（design 第 5 节）。
 */
export function formatHistory(facts = [], ctx = {}) {
  const rows = [...(Array.isArray(facts) ? facts : [])].sort(
    (a, b) => Number(factSince(a) ?? 0) - Number(factSince(b) ?? 0),
  );
  const key = String(ctx.key ?? (rows.length ? factKey(rows[0]) : '?'));
  const count = rows.length;
  const lines = [
    `[memory.history] ${key} · ${count} version${count === 1 ? '' : 's'}`,
  ];

  if (!count) {
    lines.push('（暂无记录）');
    return lines.join('\n');
  }

  // 整列都没值就整列不显示，避免出现「-  -」这种连续两个空列；单个缺失用 — 占位。
  const hasQuote = (f) => {
    const q = factQuote(f);
    return q != null && String(q).trim() !== '';
  };
  const showQuote = rows.some(hasQuote);
  const showEvidence = rows.some((f) => factSeq(f) != null);

  const valueTexts = rows.map((f) => truncate(factValue(f), VALUE_MAX));
  const quoteTexts = rows.map((f) => (hasQuote(f) ? `"${truncate(factQuote(f), QUOTE_MAX)}"` : '—'));
  const valueWidth = columnWidth(valueTexts, (t) => t, 6, 24);
  const quoteWidth = showQuote ? columnWidth(quoteTexts, (t) => t, 0, QUOTE_MAX + 2) : 0;

  rows.forEach((f, i) => {
    const status = factStatus(f);
    const cells = [
      `${formatDay(factSince(f))}  ${padRight(fitWidth(valueTexts[i], valueWidth), valueWidth)}`,
    ];
    if (showQuote) cells.push(padRight(fitWidth(quoteTexts[i], quoteWidth), quoteWidth));
    if (showEvidence) cells.push(factEvidence(f));
    cells.push(status === 'active' ? 'ACTIVE' : status);
    lines.push(cells.join('  '));
  });

  // 结尾提示按 active 条数分支：多值键（如 never-use）可以多条约束同时生效，
  // 只报「当前生效：某一条」会和上面整列 ACTIVE 自相矛盾。
  const active = rows.filter((f) => factStatus(f) === 'active');
  if (active.length === 1) {
    const current = active[0];
    const currentSeq = factSeq(current);
    // 没有证据号就只给日期，不在散文里塞占位符。
    const evidenceText = currentSeq == null ? '' : `，e${currentSeq}`;
    lines.push(
      `→ 当前生效：${truncate(factValue(current), VALUE_MAX)}` +
        `（${formatDay(factSince(current))}${evidenceText}）`,
    );
  } else if (active.length > 1) {
    lines.push(`→ ${active.length} 条同时有效（约束可以叠加）`);
  } else {
    lines.push('→ 当前无生效版本');
  }

  return lines.join('\n');
}

/**
 * 检索结果。meta: { scope, includeSuperseded, query?, now? }
 * 只在真的有下一步可做时才追加 `→`。
 */
export function formatSearchResult(hits = [], meta = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const scope = String(meta.scope ?? 'global');
  const mode = meta.includeSuperseded ? 'incl. superseded' : 'active only';
  const lines = [
    `[memory.search] ${list.length} ${list.length === 1 ? 'hit' : 'hits'} · scope=${scope} · ${mode}`,
  ];

  if (!list.length) {
    lines.push('（没有匹配的记忆；换关键词或放宽 scope 再试）');
    return lines.join('\n');
  }

  for (let i = 0; i < list.length; i += 1) {
    lines.push(formatHit(list[i], { index: i, neighbors: list[i]?.neighbors }));
  }

  const first = list.find((h) => {
    const seq = h?.unit?.seq ?? h?.event?.seq;
    const sid = h?.session?.id ?? h?.unit?.session_id;
    return seq != null && sid;
  });
  if (first) {
    const sid = first.session?.id ?? first.unit?.session_id;
    const seq = first.unit?.seq ?? first.event?.seq;
    // 这里给完整 id：提示是给模型直接拿去调工具用的，截断会调用失败。
    lines.push(`→ 完整上下文：session_event_read(session_id="${sid}", seq=${seq})`);
  }

  const stale = list.find((h) => factStatus(h?.fact) === 'superseded');
  if (stale) {
    lines.push(`→ 已废弃版本：memory(action="history", key="${factKey(stale.fact)}")`);
  }

  return lines.join('\n');
}
