// 常驻上下文：纯函数，不 import 任何 DSH 包。
// 输出形如：
//   ## 项目记忆（dsh-recall）
//   scope: D:\personal_vibe\dsh-recall
//   pkg-manager = pnpm    (2026-03-06, user)
//   ...
//   问「现在是什么 / 当时为什么 / 有没有改过」用 memory 工具；……
//   用户做出决定、纠正你、或确认某个约定时，用 memory(action="write") 记一条……

// 两句分工：什么时候查 memory、什么时候用 session_*；以及什么时候主动写。
// 合计 ≤80 字（按中文字符计），在任何输入下都只占最后两行。
export const DIVISION_OF_LABOR =
  '问「现在是什么 / 当时为什么 / 有没有改过」用 memory 工具；问「哪次会话提到过 X」用 session_* 工具。\n' +
  '用户做出决定、纠正你、或确认某个约定时，用 memory(action="write") 记一条，写清「键=值 + 依据」。';

const DIVISION_LINES = DIVISION_OF_LABOR.split('\n');
const MAX_LINES = 40;
/** v2 注入内容的安全上限（design-v2 第 7 节）；不含状态表本身。 */
export const MAX_INJECT_LINES = 200;
const DEFAULT_MAX_FACTS = 36;
const KEY_WIDTH = 20;
const VALUE_WIDTH = 32;
const MAX_VALUE_CHARS = 60;

function oneLine(value, max = MAX_VALUE_CHARS) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toDate(ts) {
  if (ts == null) return '—';
  let ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  // 兼容秒级时间戳
  if (ms < 1e12) ms *= 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

function normalizeLimit(maxFacts) {
  // 标题 + scope + 两句分工（2 行）固定占 4 行
  const fallback = MAX_LINES - 2 - DIVISION_LINES.length;
  const n = Number(maxFacts);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FACTS;
  return Math.max(1, Math.min(limit, fallback));
}

/**
 * @param {object} opts
 * @param {Array} opts.facts   facts.js listFacts() 的返回值
 * @param {string} opts.scope  cwd 绝对路径，或 'global'
 * @param {number} [opts.maxFacts] 最多展示多少条
 * @returns {string}
 */
export function buildMemoryContext({ facts = [], scope = 'global', maxFacts } = {}) {
  const list = Array.isArray(facts) ? facts.filter((f) => f && f.key) : [];
  const scopeText = oneLine(scope || 'global', 120) || 'global';
  const header = ['## 项目记忆（dsh-recall）', `scope: ${scopeText}`];

  if (list.length === 0) {
    return [...header, '暂无记忆，用 memory(action="write") 记录', ...DIVISION_LINES].join('\n');
  }

  let limit = normalizeLimit(maxFacts);
  let shown = Math.min(list.length, limit);
  let omitted = list.length - shown;
  // 截断时还要占一行说明，保证总行数 ≤ MAX_LINES
  if (omitted > 0) {
    const budget = MAX_LINES - header.length - DIVISION_LINES.length - 1; // 留省略行
    if (shown > budget) {
      shown = Math.max(1, budget);
      omitted = list.length - shown;
    }
  }

  const visible = list.slice(0, shown);
  const keyW = Math.min(
    KEY_WIDTH,
    visible.reduce((w, f) => Math.max(w, oneLine(f.key, 40).length), 0),
  );
  const valW = Math.min(
    VALUE_WIDTH,
    visible.reduce((w, f) => Math.max(w, oneLine(f.value ?? f.quote, MAX_VALUE_CHARS).length), 0),
  );

  const rows = visible.map((fact) => {
    const key = oneLine(fact.key, 40);
    // 有 value 用 value；只有引文的事实退回展示引文，避免整行变成「—」。
    const value = oneLine(fact.value ?? fact.quote, MAX_VALUE_CHARS) || '—';
    const date = toDate(fact.since ?? fact.created_at ?? fact.verified_at);
    const author = oneLine(fact.author, 12) || '?';
    const status = fact.status && fact.status !== 'active' ? `, ${fact.status}` : '';
    return `${key.padEnd(keyW)} = ${value.padEnd(valW)}  (${date}, ${author}${status})`;
  });

  if (omitted > 0) {
    rows.push(`… 省略 ${omitted} 条（用 memory(action="state") 看全部）`);
  }

  const lines = [...header, ...rows, ...DIVISION_LINES];
  // 双保险：任何输入都不超过 MAX_LINES 行
  return lines.slice(0, MAX_LINES).join('\n');
}

/**
 * v2：状态表在前，span/topic 注入内容附在其后。
 * injection 为空时与 buildMemoryContext 完全一致（保证 v1 行为不变）。
 *
 * @param {object} opts
 * @param {Array} opts.facts
 * @param {string} opts.scope
 * @param {number} [opts.maxFacts]
 * @param {string} [opts.injection] buildInjectionSync() 的 text
 * @returns {string}
 */
export function composeMemoryContext({ facts = [], scope = 'global', maxFacts, injection } = {}) {
  const base = buildMemoryContext({ facts, scope, maxFacts });
  const extra = typeof injection === 'string' ? injection.trim() : '';
  return extra ? `${base}\n\n${extra}` : base;
}
