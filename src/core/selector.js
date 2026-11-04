/**
 * src/core/selector.js
 *
 * v2 读取侧的选择器：问题 + 候选主题 -> 打开主题 -> 选 span。
 *
 * 接口（docs/design-v2.md 第 6 节，冻结）：
 *   selectSpans({ question, topics, activeTools, complete, openTopic })
 *     -> { selected:[{span_id, why}], skip, openedTopics }
 *
 * 两阶段（一次函数调用，内部两次模型调用）：
 *   1. 打开阶段：候选主题 {slug,title,description} + 问题 + 工具名 -> {"open":["slug",...]}
 *      最多 4 个；没打开任何主题直接返回 skip=true，不调第二次模型。
 *   2. 选择阶段：openTopic(slug) 拿到 span -> {"selected":[{"span_id","why"}],"skip":false}
 *
 * 容错：两阶段任一失败（模型报错/返回坏 JSON/openTopic 抛错）都返回空结果，不抛异常。
 */

/** 最多打开几个主题（design-v2 3.3） */
export const MAX_OPEN_TOPICS = 4;
/** 最多几个主题进入选择器（design-v2 第 4 节） */
export const MAX_CANDIDATE_TOPICS = 8;
/** why 最长字数 */
export const MAX_WHY_CHARS = 60;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clipChars(value, limit) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}

function stripJsonFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) return trimmed.slice(3).replace(/```\s*$/, '').trim();
  return trimmed.slice(firstBreak + 1).replace(/```\s*$/, '').trim();
}

/** 模型返回对象 / JSON 字符串（可带围栏）→ JS 对象；无法解析返回 null。 */
function parseJsonLoose(raw) {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const candidates = [raw.trim()];
  const fenced = stripJsonFence(raw);
  if (fenced !== candidates[0]) candidates.push(fenced);
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(raw.slice(open, close + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch {
      // 试下一种
    }
  }
  return null;
}

function normalizeTopicCandidates(topics) {
  const list = Array.isArray(topics) ? topics : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (slug === '' || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      description: typeof item.description === 'string' ? item.description.trim() : '',
    });
  }
  return out.slice(0, MAX_CANDIDATE_TOPICS);
}

function normalizeActiveTools(activeTools) {
  if (typeof activeTools === 'string') {
    const value = activeTools.trim();
    return value === '' ? [] : [value];
  }
  const list = Array.isArray(activeTools) ? activeTools : [];
  const out = [];
  for (const item of list) {
    const name = typeof item === 'string'
      ? item.trim()
      : (typeof item?.name === 'string' ? item.name.trim() : '');
    if (name !== '') out.push(name);
  }
  return out;
}

/** openTopic 的返回值归一化成 [{id,type,text,turns}]。 */
function normalizeOpenedSpans(value) {
  const list = Array.isArray(value)
    ? value
    : (Array.isArray(value?.spans) ? value.spans : []);
  const out = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id === '') continue;
    const turnsRaw = Array.isArray(item.turns) ? item.turns : [];
    const turns = turnsRaw
      .map((turn) => Number(turn))
      .filter((turn) => Number.isFinite(turn))
      .map((turn) => Math.trunc(turn));
    out.push({
      id,
      type: typeof item.type === 'string' ? item.type : '',
      text: typeof item.text === 'string' ? item.text : '',
      turns,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt 1：打开主题
// ---------------------------------------------------------------------------

const OPEN_SYSTEM_PROMPT = `你是「记忆主题选择器」：判断回答用户问题需要打开哪些主题，只输出 JSON。

规则：
- 最多打开 4 个主题；只打开确实可能包含答案的，不要贪多。
- 可以结合当前激活的工具名判断（例如检索/读文件类工具可能需要历史操作主题）。
- slug 必须从候选主题里选，不能编造；同一 slug 只出现一次。
- 没有相关主题就返回 {"open":[]}。

只输出 JSON，不要解释：
{"open":["tts-emotion"]}`;

function buildOpenMessages({ question, topics, activeTools }) {
  const lines = topics.map((topic) => (
    `- ${topic.slug} | ${topic.title || '(无标题)'} | ${topic.description || '(无描述)'}`
  ));
  return [
    { role: 'system', content: OPEN_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `用户问题：${question}`,
        `当前工具：${activeTools.length > 0 ? activeTools.join(', ') : '（无）'}`,
        '',
        '候选主题（slug | title | description）：',
        ...(lines.length > 0 ? lines : ['（无候选主题）']),
      ].join('\n'),
    },
  ];
}

/** 校验打开阶段：slug 必须来自候选，去重，最多 4 个。 */
function parseOpenResponse(raw, candidates) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : parsed.open;
  if (!Array.isArray(list)) return [];

  const allowed = new Set(candidates.map((topic) => topic.slug));
  const opened = [];
  const seen = new Set();
  for (const value of list) {
    const slug = typeof value === 'string' ? value.trim() : '';
    if (slug === '' || !allowed.has(slug) || seen.has(slug)) continue;
    seen.add(slug);
    opened.push(slug);
    if (opened.length >= MAX_OPEN_TOPICS) break;
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Prompt 2：选 span
// ---------------------------------------------------------------------------

const SELECT_SYSTEM_PROMPT = `你是「记忆 span 选择器」：从已打开主题的 span 里挑出能帮助回答用户问题的，只输出 JSON。

规则：
- span_id 必须从下面列表里选，不能编造。
- why 用一句中文说明它为什么有用，≤60 字。
- 只选真正相关的；没有有用的就返回 {"selected":[],"skip":true}。
- 同一 span_id 只出现一次。

只输出 JSON，不要解释：
{"selected":[{"span_id":"sp_1","why":"直接回答了情感参数怎么配"}],"skip":false}`;

function buildSelectMessages({ question, openedTopics, spans }) {
  const lines = spans.map((span) => (
    `- ${span.id} | ${span.type || 'span'} | 轮次 ${span.turns.join(',') || '?'} | ${span.text}`
  ));
  return [
    { role: 'system', content: SELECT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `用户问题：${question}`,
        `已打开主题：${openedTopics.length > 0 ? openedTopics.join(', ') : '（无）'}`,
        '',
        'span（id | type | turns | text）：',
        ...(lines.length > 0 ? lines : ['（无 span）']),
      ].join('\n'),
    },
  ];
}

/** 校验选择阶段：span_id 必须来自已打开主题，why 截断到 60 字。 */
function parseSelectResponse(raw, allowedIds) {
  const parsed = parseJsonLoose(raw);
  if (!parsed) return { selected: [], skip: true };
  const list = Array.isArray(parsed) ? parsed : parsed.selected;
  const skipFlag = !Array.isArray(parsed) && parsed.skip === true;
  if (!Array.isArray(list)) return { selected: [], skip: true };

  const selected = [];
  const seen = new Set();
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const spanId = typeof item.span_id === 'string'
      ? item.span_id.trim()
      : (typeof item.id === 'string' ? item.id.trim() : '');
    if (spanId === '' || !allowedIds.has(spanId) || seen.has(spanId)) continue;
    seen.add(spanId);
    const why = typeof item.why === 'string' ? clipChars(item.why.trim(), MAX_WHY_CHARS) : '';
    selected.push({ span_id: spanId, why });
  }

  return {
    selected,
    skip: skipFlag || selected.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 两阶段选择 span。
 *
 * @param {{
 *   question: string,
 *   topics: Array<{slug:string, title?:string, description?:string}>,
 *   activeTools?: string[]|string,
 *   complete: (messages: Array<{role:string, content:string}>) => Promise<object|string>,
 *   openTopic: (slug: string) => Promise<Array<{id:string, type?:string, text?:string, turns?:number[]}>>
 * }} input
 * @returns {Promise<{ selected: Array<{span_id:string, why:string}>, skip: boolean, openedTopics: string[] }>}
 */
export async function selectSpans(input = {}) {
  const empty = { selected: [], skip: true, openedTopics: [] };
  const complete = input?.complete;
  const openTopic = input?.openTopic;
  if (typeof complete !== 'function' || typeof openTopic !== 'function') return empty;

  const question = typeof input?.question === 'string' ? input.question.trim() : '';
  if (question === '') return empty;

  const candidates = normalizeTopicCandidates(input?.topics);
  if (candidates.length === 0) return empty;
  const activeTools = normalizeActiveTools(input?.activeTools);

  // 阶段 1：打开主题
  let opened;
  try {
    const raw = await complete(buildOpenMessages({ question, topics: candidates, activeTools }));
    opened = parseOpenResponse(raw, candidates);
  } catch {
    return empty;
  }
  if (opened.length === 0) return empty;

  // 对每个打开的主题拿 span；单个主题失败只跳过它
  const openedTopics = [];
  const spanById = new Map();
  const spanOrder = [];
  for (const slug of opened) {
    let list;
    try {
      list = await openTopic(slug);
    } catch {
      continue;
    }
    openedTopics.push(slug);
    for (const span of normalizeOpenedSpans(list)) {
      if (spanById.has(span.id)) continue;
      spanById.set(span.id, span);
      spanOrder.push(span.id);
    }
  }

  if (openedTopics.length === 0) return empty;
  if (spanOrder.length === 0) {
    return { selected: [], skip: true, openedTopics };
  }

  // 阶段 2：选 span
  const spans = spanOrder.map((id) => spanById.get(id));
  try {
    const raw = await complete(buildSelectMessages({ question, openedTopics, spans }));
    const parsed = parseSelectResponse(raw, new Set(spanOrder));
    return {
      selected: parsed.selected,
      skip: parsed.skip || parsed.selected.length === 0,
      openedTopics,
    };
  } catch {
    return { selected: [], skip: true, openedTopics };
  }
}

export default { selectSpans, MAX_OPEN_TOPICS, MAX_WHY_CHARS };
