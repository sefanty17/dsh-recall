/**
 * src/core/rules.js
 *
 * 规则扫描：把一段自然语言转成「候选事实」。
 *
 * 设计约束（docs/design.md 第 4 节，冻结）：
 *   scanText(text, { time, author, scope }) -> Candidate[]
 *   Candidate: { keyHint, kind, value, quote, drift, confidence, evidence: { start, end } }
 *
 * 硬约束：text.slice(evidence.start, evidence.end + 1) === quote 必须逐字成立。
 *
 * 质量约束（v0.1 收紧，真实数据驱动）：
 *   1. value 必须是标识符形态，或在引号内且 ≤40 字；抽不出合格 value 的候选直接丢弃
 *   2. 问句（？/?/吗/能不能/是否/可不可以）不抽
 *   3. 英文只保留高精度句式：always use / never use / don't use /
 *      use X instead of Y / switch to X / migrate to X
 *   4. keyHint 的关键词必须出现在触发词前后 20 字内，否则退化为 note
 *
 * 本模块是纯函数：无 I/O、无依赖、不读时间/环境。
 */

/**
 * @typedef {{ start: number, end: number }} Span   // 闭区间，字符偏移
 * @typedef {{
 *   keyHint: string,
 *   kind: 'preference'|'constraint'|'decision'|'failure',
 *   value: string,
 *   quote: string,
 *   drift: 'stable'|'slow'|'fast',
 *   confidence: number,
 *   evidence: Span,
 * }} Candidate
 */

/** 单段文本最多返回的候选数 */
const MAX_CANDIDATES = 20;
/** 引文最大长度（超出时回退成「触发词附近」的窄引文） */
const MAX_QUOTE = 120;
/** 长句回退时，触发词左侧保留的上下文长度 */
const LEFT_CONTEXT = 20;
/** keyHint 关键词与触发词的最大距离（字） */
const KEY_WINDOW = 20;
/** 引号内 value 的最大长度 */
const MAX_QUOTED_VALUE = 40;

/** 句子/分句边界；ASCII 句点只在后接空白或结尾时才算边界（避免切断 deploy.sh、v1.2） */
const HARD_BREAK_RE = /[。！？!?；;，,\n\r]/;
/** 问句检测用的句子边界（比分句更宽：不切逗号） */
const SENTENCE_BREAK_RE = /[。！？!?；;\n\r]/;
/** 问句标记：出现任意一个就整句不抽 */
const QUESTION_RE = /[？?吗]|能不能|是否|可不可以/;

const IDENT_SRC = '[A-Za-z0-9_.@/+-]{1,40}';
const IDENT_RE = new RegExp(IDENT_SRC, 'g');

/**
 * 合格的 value（标识符形态）：
 *   至少 2 字符，字母/数字开头，可含 . _ @ / : -
 *   不允许空格、中文、引号
 */
const VALUE_IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._@/:\-]{1,39}$/;

/** 引号括起来的整段（中文引号/日文引号/反引号/单双引号） */
const QUOTED_RE = /[`"'\u300c\u300e]([^`"'\u300d\u300f\n]{1,40})[`"'\u300d\u300f]/;

const QUOTE_OPEN = '`"\'「『';

/** 动词 + 紧随其后的整段引文，优先于裸标识符 */
const VERB_QUOTED_RE = /(?:切换到|切换成|切到|改成|改为|换成|改用|换到|使用|采用|走|用|\b(?:install|switch(?:ing)?\s+to|migrate\s+to|adopt|use)\b)\s*[`"'「『]([^`"'」』\n]{1,40})[`"'」』]/i;

/** 动词 + 紧随其后的标识符（value 抽取的主力） */
const VERB_VALUE_RE = new RegExp(
  '(?:切换到|切换成|切到|改成|改为|换成|改用|换到|使用|采用|走|用'
    + '|\\b(?:install|switch(?:ing)?\\s+to|migrate\\s+to|adopt|use)\\b)'
    + '\\s*[' + QUOTE_OPEN + ']?(' + IDENT_SRC + ')',
  'i',
);

/** 禁止类线索（用于 constraint -> never-use） */
const NEVER_CUE_RE = /(?:不要|禁止|避免|不许|不准|不得|不能|别|never|don'?t|do not)/gi;

/** 失败线索前的否定语境：「未发现失败」「没有报错」不算失败事实 */
const NEGATED_FAILURE_RE = /(?:未|没|没有|无|不|别|并未|未曾|尚未|不会)[^。！？!?；;，,\s]{0,2}$/;

/**
 * 规则表。
 * 同一段文本会被所有规则扫描；之后按 confidence 去重（重叠的只留最高的）。
 * 英文只保留高精度句式，其余英文叙述一律不抽（真实数据里全是噪声）。
 */
const RULES = [
  // 中文强禁止词
  {
    kind: 'constraint',
    confidence: 0.92,
    re: /(?:不要|禁止|避免|不许|不准|不得|不能)/g,
  },
  // 「别」单独出现歧义太大（别人/特别/区别），必须紧跟动词
  {
    kind: 'constraint',
    confidence: 0.9,
    re: /别(?:再|去|乱|瞎)?\s*(?:使用|采用|走|用|动|碰|改|提交|引入|安装|删掉|删|装|升级|调用|搞|写|加)/g,
  },
  // 英文只认 never use / don't use / do not use
  {
    kind: 'constraint',
    confidence: 0.92,
    re: /(?:never|don'?t|do not)\s+use\b/gi,
  },
  // 中文偏好
  {
    kind: 'preference',
    confidence: 0.84,
    re: /(?:以后|今后|日后|后续|将来|一律|统一|全部|所有|都|固定|规定|指定|必须)\s*(?:[^。！？!?；;，,\n]{0,10}?)(?:使用|采用|走|用|改为|改成|换成|改用|切换到)/g,
  },
  // 英文 always use
  {
    kind: 'preference',
    confidence: 0.84,
    re: /\balways\s+use\b/gi,
  },
  // 中文取代信号：用于 supersede 的强线索，kind 用 decision
  {
    kind: 'decision',
    confidence: 0.9,
    re: /(?:改用|换成|改成|不再用|弃用|切换到|切换成|替换为|迁移到|迁到)/g,
  },
  // 英文 switch to / migrate to
  {
    kind: 'decision',
    confidence: 0.9,
    re: /\b(?:switch(?:ed)?\s+to|migrate\s+to)\b/gi,
  },
  // use X instead of Y：只吞「use 」，让 value 落在后面的标识符上
  {
    kind: 'decision',
    confidence: 0.88,
    re: /\buse\s+(?=[A-Za-z0-9][A-Za-z0-9._@/:\-]{0,39}\s+instead\s+of\b)/gi,
  },
  // 中文决策
  {
    kind: 'decision',
    confidence: 0.86,
    re: /(?:决定|定了|定下来|就用|采用|选定|拍板|敲定|确定用)/g,
  },
  // 中文失败
  {
    kind: 'failure',
    confidence: 0.82,
    re: /(?:试过|失败|挂了|报错|踩坑|崩了|回滚|不行|装不上|装不了|跑不起来|起不来)/g,
  },
];

/**
 * keyHint 关键词表：按优先级排列。
 * 每个关键词都必须落在触发词 ±20 字内才算命中；否则继续找，最终兜底 note。
 */
const KEY_RULES = [
  {
    key: 'pkg-manager',
    re: /包管理器|依赖|\bnpm\b|\bpnpm\b|\byarn\b|\bbun\b|lockfile|node_modules|package\.json|\bdeno\b|corepack|registry/gi,
  },
  {
    key: 'test-command',
    re: /测试|单测|集成测试|用例|\btest\b|\bjest\b|\bvitest\b|\bmocha\b|\bpytest\b|coverage|覆盖率/gi,
  },
  {
    key: 'build-command',
    re: /构建|打包|编译|\bbuild\b|\bvite\b|\bwebpack\b|\brollup\b|\besbuild\b|\btsc\b|\bbabel\b|\bturbo\b/gi,
  },
  {
    key: 'deploy',
    re: /部署|上线|发布|\bdeploy\b|\brelease\b|\bci\b|流水线|\bvercel\b|\bnetlify\b|\bdocker\b|\bk8s\b|kubernetes|\bpm2\b/gi,
  },
  {
    key: 'branch-policy',
    re: /分支|\bbranch\b|主干|\btrunk\b|\bmain\b|\bmaster\b|\bmerge\b|\brebase\b|\bsquash\b|feature\s*branch/gi,
  },
  {
    key: 'port',
    re: /端口|\bport\b|localhost:\d{1,5}|127\.0\.0\.1:\d{1,5}/gi,
  },
  {
    key: 'version',
    re: /版本|\bversion\b|node\s*v?\d|v\d+\.\d+|升级到|降级到/gi,
  },
];

/** keyHint -> drift（变化速度：pkg/test/build/deploy 慢，branch/port/version 快） */
const DRIFT_BY_KEY = {
  'pkg-manager': 'slow',
  'test-command': 'slow',
  'build-command': 'slow',
  deploy: 'slow',
  'branch-policy': 'fast',
  port: 'fast',
  version: 'fast',
};

/**
 * typed key 的取值域校验。
 * key 是有语义槽位的，抽到的 value 必须落在槽位里；落不进去就降级成 note。
 * never-use 天然开放，只要求标识符形态。
 */
const VALUE_VALIDATORS = {
  'pkg-manager': /^(npm|pnpm|yarn|bun|pip|poetry|uv|cargo|go|maven|gradle|composer)$/i,
  'test-command': /(test|pytest|jest|vitest|mocha|go test|cargo test|node --test)/i,
  'build-command': /(build|make|cargo build|tsc|vite build|webpack)/i,
  'branch-policy': /^(main|master|develop|trunk|release\/.+|feature\/.+)$/i,
  port: /^\d{2,5}$/,
  'never-use': /^[A-Za-z0-9][A-Za-z0-9._@/:\-]{0,39}$/,
};

/** 判断 text[i] 是否是分句边界 */
function isBreakAt(text, i) {
  const ch = text[i];
  if (ch === undefined) return false;
  if (HARD_BREAK_RE.test(ch)) return true;
  if (ch === '.') {
    // deploy.sh / v1.2.3 里的点不是边界
    const next = text[i + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

/** 整段就是一个 ``` 代码块 -> 跳过 */
function isCodeOnly(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('```') && trimmed.endsWith('```') && trimmed.length >= 6;
}

/** 取匹配所在的整句（含句末标点），用于问句判断 */
function sentenceAt(text, index) {
  let start = index;
  while (start > 0 && !SENTENCE_BREAK_RE.test(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !SENTENCE_BREAK_RE.test(text[end])) end += 1;
  if (end < text.length) end += 1;
  return text.slice(start, end);
}

/** 问句不抽（决策/偏好/约束都可能被问句伪装） */
function isQuestionAt(text, index) {
  return QUESTION_RE.test(sentenceAt(text, index));
}

/**
 * 计算一条引文的闭区间：以「分句」为单位，尽量包含触发词和值。
 * 分句过长时回退到触发词附近，保证引文紧凑。
 */
function quoteBounds(text, matchStart, matchEnd) {
  let start = matchStart;
  while (start > 0 && !isBreakAt(text, start - 1)) start -= 1;

  let end = matchEnd; // 匹配结束后的第一个字符
  while (end < text.length && !isBreakAt(text, end)) end += 1;
  end -= 1; // 转为闭区间

  if (end - start + 1 > MAX_QUOTE) {
    start = Math.max(start, matchStart - LEFT_CONTEXT);
    end = Math.min(end, start + MAX_QUOTE - 1);
  }

  while (start <= end && /\s/.test(text[start])) start += 1;
  while (end >= start && /\s/.test(text[end])) end -= 1;

  return { start, end };
}

/** 取第一个标识符 */
function firstIdent(str) {
  IDENT_RE.lastIndex = 0;
  const m = IDENT_RE.exec(str);
  return m ? m[0] : null;
}

/** 取最后一个标识符 */
function lastIdent(str) {
  IDENT_RE.lastIndex = 0;
  let found = null;
  let m;
  while ((m = IDENT_RE.exec(str)) !== null) found = m[0];
  return found;
}

/** 规范化学抽到的原始值（去空白、去首尾标点/引号） */
function cleanValue(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  value = value.replace(/[.,;:!?]+$/, '');
  value = value.replace(/^[`"'\u300c\u300e]/, '').replace(/[`"'\u300d\u300f]$/, '');
  return value.length > 0 ? value : null;
}

/** 标识符形态的 value */
function isIdentifierValue(value) {
  return typeof value === 'string' && VALUE_IDENT_RE.test(value);
}

/** 引号内、≤40 字、不含换行的 value */
function isQuotedValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_QUOTED_VALUE && !/[\n\r]/.test(trimmed);
}

/**
 * 抽 value；只返回「合格」的值，抽不出就返回 null（候选会被丢弃）。
 * 顺序：失败前缀 -> 动词+引文 -> 动词+标识符 -> 引文 -> 标识符。
 */
function findValue(quote, matchRel, kind) {
  const after = quote.slice(matchRel);

  if (kind === 'failure') {
    const before = cleanValue(lastIdent(quote.slice(0, matchRel)));
    if (before && isIdentifierValue(before)) return before;
  }

  const verbQuoted = VERB_QUOTED_RE.exec(after);
  if (verbQuoted && verbQuoted[1]) {
    const value = cleanValue(verbQuoted[1]);
    if (value && isQuotedValue(value)) return value;
  }

  const verb = VERB_VALUE_RE.exec(after);
  if (verb && verb[1]) {
    const value = cleanValue(verb[1]);
    if (value && isIdentifierValue(value)) return value;
  }

  const quoted = QUOTED_RE.exec(after);
  if (quoted && quoted[1]) {
    const value = cleanValue(quoted[1]);
    if (value && isQuotedValue(value)) return value;
  }

  const ident = firstIdent(after);
  if (ident) {
    const value = cleanValue(ident);
    if (value && isIdentifierValue(value)) return value;
  }

  return null;
}

/** 两个闭区间之间的距离（不重叠时为间隔字符数） */
function distanceBetween(aStart, aEnd, bStart, bEnd) {
  if (aEnd < bStart) return bStart - aEnd - 1;
  if (bEnd < aStart) return aStart - bEnd - 1;
  return 0;
}

/** 关键词是否落在触发词 ±KEY_WINDOW 字内 */
function isNear(aStart, aEnd, triggerStart, triggerEnd) {
  return distanceBetween(aStart, aEnd, triggerStart, triggerEnd) <= KEY_WINDOW;
}

/**
 * keyHint：关键词必须靠近触发词；constraint 且出现禁止词时优先 never-use。
 * 都不满足就退化为 note。
 */
function keyHintFor(kind, quote, triggerStart, triggerEnd) {
  if (kind === 'constraint') {
    for (const m of quote.matchAll(NEVER_CUE_RE)) {
      if (isNear(m.index, m.index + m[0].length - 1, triggerStart, triggerEnd)) {
        return 'never-use';
      }
    }
  }
  for (const rule of KEY_RULES) {
    for (const m of quote.matchAll(rule.re)) {
      if (isNear(m.index, m.index + m[0].length - 1, triggerStart, triggerEnd)) {
        return rule.key;
      }
    }
  }
  return 'note';
}

/** 由一次正则命中生成候选；value 不合格直接丢弃 */
function buildCandidate(text, matchStart, matchLength, rule) {
  const matchEnd = matchStart + matchLength;
  const { start, end } = quoteBounds(text, matchStart, matchEnd);
  if (end < start) return null;

  const quote = text.slice(start, end + 1);
  if (!quote) return null;

  const matchRel = Math.max(0, matchStart - start);
  const value = findValue(quote, matchRel, rule.kind);
  if (!value) return null;

  let keyHint = keyHintFor(rule.kind, quote, matchRel, matchRel + matchLength - 1);
  // typed key 的 value 不在槽位取值域内 -> 降级为 note（保留 kind/quote/evidence）
  const validator = VALUE_VALIDATORS[keyHint];
  if (validator && !validator.test(value)) keyHint = 'note';
  const drift = DRIFT_BY_KEY[keyHint] || 'stable';

  let confidence = rule.confidence + 0.02;
  confidence = Math.max(0.3, Math.min(0.99, confidence));
  confidence = Math.round(confidence * 100) / 100;

  return {
    keyHint,
    kind: rule.kind,
    value,
    quote,
    drift,
    confidence,
    evidence: { start, end },
  };
}

/** 两个闭区间是否重叠 */
function overlaps(a, b) {
  return a.evidence.start <= b.evidence.end && b.evidence.start <= a.evidence.end;
}

/**
 * 扫描一段文本，返回候选事实。
 * @param {string} text
 * @param {{ time?: number|null, author?: string|null, scope?: string|null }} [options]
 * @returns {Candidate[]}
 */
export function scanText(text, options) {
  // options 目前不影响抽取结果，只为对齐冻结接口（时间/作者由调用方写入 fact）。
  void options;

  if (typeof text !== 'string') return [];
  if (text.trim() === '') return [];
  if (isCodeOnly(text)) return [];

  const found = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex += 1;
        continue;
      }
      // 问句不抽
      if (isQuestionAt(text, m.index)) continue;
      // 否定语境里的失败线索不抽
      if (rule.kind === 'failure') {
        const before = text.slice(Math.max(0, m.index - 4), m.index);
        if (NEGATED_FAILURE_RE.test(before)) continue;
      }
      const candidate = buildCandidate(text, m.index, m[0].length, rule);
      if (candidate) found.push(candidate);
    }
  }

  // 按 confidence 从高到低，重叠的候选只保留置信度最高的那个
  const ranked = found.slice().sort((a, b) => (
    b.confidence - a.confidence
    || a.evidence.start - b.evidence.start
    || (b.evidence.end - b.evidence.start) - (a.evidence.end - a.evidence.start)
  ));

  const kept = [];
  for (const candidate of ranked) {
    if (kept.length >= MAX_CANDIDATES) break;
    if (kept.some((other) => overlaps(candidate, other))) continue;
    kept.push(candidate);
  }

  // 输出按原文顺序，便于调用方顺序阅读
  kept.sort((a, b) => a.evidence.start - b.evidence.start);
  return kept;
}

export default scanText;
