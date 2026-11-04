/**
 * src/core/topics.js
 *
 * v2 topic 层（主题）：主题 md 文件的渲染 / 解析、DB 落表、git 手改保护。
 * 文件格式与目录规则见 docs/design-v2.md 第 5 节（冻结）：
 *   <dir>/<scopeSlug>/<slug>.md
 *
 * git 保护（第 5 节）：
 *   - dir 必须是**独立仓库根**：只是外层项目仓库里的子目录时强制 git init 一个
 *     嵌套仓库，绝不复用外层（否则 add/commit 会动到整个项目）
 *   - 写之前 git status --porcelain -- <file>：干净 → 直接覆盖
 *   - 脏 → 以 `## ` 标题为块做三方合并（base = HEAD 里的上一版，ours = 磁盘，
 *     theirs = 本次生成）：人改过的块保留，模型新增/更新的块照常写入；
 *     被挤掉的模型建议写进文件末尾 `## 待合并（日期）`，每次重建不堆积
 *   - 拿不到 HEAD 版本、无法判断时 → 保留人改版本，把新内容降一级标题追加到
 *     `## 待合并` 区
 *   - 写完 `git add -A -- .`（限定 topic 目录）&& `git commit -m "curate: <slug>"`
 *   - 任何 git 失败都不抛，只告警，返回里带 git:false
 *
 * 所有写文件测试必须传 { dir: tmpdir }，默认目录只用于真实运行：
 *   dir 参数 → DSH_RECALL_TOPIC_DIR → ~/.dsh/recall/topics
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { listSpans } from './spans.js';
import { saveTopicVectors } from './vectors.js';

const DEFAULT_TOPIC_DIR_ENV = 'DSH_RECALL_TOPIC_DIR';
const GIT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// 路径 / slug
// ---------------------------------------------------------------------------

/** 默认主题目录：DSH_RECALL_TOPIC_DIR → ~/.dsh/recall/topics（测试一律传 dir）。 */
export function defaultTopicDir(env = process.env) {
  const configured = String(env?.[DEFAULT_TOPIC_DIR_ENV] ?? '').trim();
  if (configured) return resolve(configured);
  return join(homedir(), '.dsh', 'recall', 'topics');
}

/**
 * scope → 目录名：非字母数字全部换成 '-'，截断 60 字符，去掉首尾 '-'。
 * 空 scope（或全是非字母数字）退化为 'global'。
 */
export function scopeSlug(scope) {
  const raw = String(scope ?? '').trim() || 'global';
  const slug = raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '');
  return slug.slice(0, 60).replace(/-+$/, '') || 'global';
}

/** topic slug → 文件名：小写，只留 [a-z0-9._-]，兜底 'topic'。 */
export function topicSlug(slug) {
  const raw = String(slug ?? '').trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-+$/, '');
  return cleaned.slice(0, 80) || 'topic';
}

/** <dir>/<scopeSlug>/<slug>.md（绝对路径）。 */
export function topicFilePath(dir, scope, slug) {
  return join(resolve(String(dir)), scopeSlug(scope), `${topicSlug(slug)}.md`);
}

// ---------------------------------------------------------------------------
// markdown 渲染
// ---------------------------------------------------------------------------

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function isoOf(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeIdList(value) {
  return [...new Set(toArray(value).map((item) => String(item)).filter((item) => item !== ''))];
}

function spanTurns(span) {
  return toArray(span?.turns)
    .map((turn) => Number(turn))
    .filter((turn) => Number.isInteger(turn));
}

function formatSpanLine(span) {
  const type = oneLine(span?.type) || 'narrative';
  const text = oneLine(span?.text);
  const turns = spanTurns(span);
  const suffix = turns.length ? `（turns ${turns.join(',')}）` : '';
  return `- [${type}] ${text}${suffix}`;
}

/**
 * 渲染主题文件（第 5 节格式）。
 * span_ids 优先取 topic.span_ids，没有就用 spans 里的 id。
 *
 * @param {object} topic   { title, description, span_ids, updated_at, updated }
 * @param {Array} [spans]  [{ id, type, text, turns }]
 * @returns {string} 以 '\n' 结尾的完整 markdown
 */
export function renderTopicMarkdown(topic = {}, spans = []) {
  const list = Array.isArray(spans) ? spans.filter((span) => span && typeof span === 'object') : [];
  const declared = normalizeIdList(topic?.span_ids);
  const ids = declared.length ? declared : normalizeIdList(list.map((span) => span.id));

  const title = oneLine(topic?.title ?? topic?.slug ?? '');
  const updated = isoOf(topic?.updated ?? topic?.updated_at);

  const head = ['---', `title: ${title}`, `updated: ${updated}`];
  if (ids.length) {
    head.push('spans:');
    for (const id of ids) head.push(`  - ${id}`);
  } else {
    head.push('spans: []');
  }
  head.push('---');

  const body = [];
  const description = String(topic?.description ?? '').trim();
  if (description) body.push(description, '');
  body.push('## spans');
  for (const span of list) body.push(formatSpanLine(span));

  return `${head.join('\n')}\n\n${body.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// markdown 解析
// ---------------------------------------------------------------------------

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * 20 行 YAML 子集：只支持 `key: value` 与 `key:` 后跟 `  - item`。
 * 引号会去掉；`[]` 解析为空数组。未知/无法识别的行直接忽略。
 */
function parseFrontmatterLite(raw) {
  const out = {};
  let currentKey = null;
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item && currentKey) {
      if (!Array.isArray(out[currentKey])) continue;
      out[currentKey].push(unquote(item[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim();
    currentKey = key;
    if (value === '' || value === '[]') {
      out[key] = [];
    } else if (value === '{}') {
      out[key] = {};
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
}

/** 把完整 markdown 拆成 frontmatter 头（含结尾换行）与 body。 */
function splitMarkdown(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const match = /^---\n[\s\S]*?\n---[ \t]*\n?/.exec(text);
  if (!match) return { head: '', body: text.replace(/^\n+/, '').trimEnd() };
  return {
    head: `${match[0].replace(/\n+$/, '')}\n`,
    body: text.slice(match[0].length).replace(/^\n+/, '').trimEnd(),
  };
}

/**
 * 解析主题文件。文件不存在会抛 ENOENT（调用方自己决定要不要兜底）。
 *
 * @param {string} filePath
 * @returns {{ path:string, frontmatter:object, title:string|null,
 *             updated:string|null, spans:string[], body:string }}
 */
export function readTopicFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const { head, body } = splitMarkdown(raw);
  const frontmatter = parseFrontmatterLite(
    head.replace(/^---\n/, '').replace(/\n---\n?$/, ''),
  );
  const spans = Array.isArray(frontmatter.spans) ? frontmatter.spans.map(String) : [];
  return {
    path: filePath,
    frontmatter,
    title: frontmatter.title ?? null,
    updated: frontmatter.updated ?? null,
    spans,
    body,
  };
}

// ---------------------------------------------------------------------------
// 三方合并（块级）
// ---------------------------------------------------------------------------

function canon(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim();
}

function sameContent(a, b) {
  return canon(a) === canon(b);
}

function bodyOf(markdown) {
  return splitMarkdown(markdown).body;
}

/** body → { preamble, blocks:[{heading,text}] }；块从 `## ` 标题开始。 */
function parseBlocks(body) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').replace(/^\n+/, '').trimEnd().split('\n');
  const preamble = [];
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return {
    preamble: preamble.join('\n').trimEnd(),
    blocks: blocks.map((block) => ({
      heading: block.heading,
      text: block.lines.join('\n').trimEnd(),
    })),
  };
}

/**
 * `## 待合并` 区：模型建议被手改版本挤掉时，不能静默丢弃，统一追加到文件末尾。
 * 每次生成都重建（旧建议先剥掉），所以不会堆积历史。
 */
const PENDING_PREFIX = '待合并';

function isPendingHeading(heading) {
  return String(heading ?? '').startsWith(PENDING_PREFIX);
}

function dateStamp(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function withoutPending(blocks) {
  return blocks.filter((block) => !isPendingHeading(block.heading));
}

/** 上一次 `## 待合并` 里列出的冲突标签（`### 描述` / `### spans` …）。 */
function pendingLabelsFrom(blocks) {
  const labels = new Set();
  for (const block of blocks) {
    if (!isPendingHeading(block.heading)) continue;
    for (const line of block.text.split('\n')) {
      if (line.startsWith('### ')) labels.add(line.slice(4).trim());
    }
  }
  return labels;
}

function demoteHeadings(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line.startsWith('## ') ? `### ${line.slice(3)}` : line))
    .join('\n');
}

/** 去掉块自己的 `## heading` 行，其余内容降一级标题。 */
function blockBody(blockText) {
  const lines = String(blockText ?? '').split('\n');
  lines.shift();
  return demoteHeadings(lines.join('\n').trim());
}

function renderPendingSection(conflicts, date) {
  const lines = [`## ${PENDING_PREFIX}（${date}）`];
  for (const conflict of conflicts) {
    lines.push('', `### ${conflict.label}`, '');
    if (conflict.label === '描述') {
      lines.push(`模型建议的新描述：${conflict.text}`);
    } else {
      lines.push(blockBody(conflict.text));
    }
  }
  return lines.join('\n');
}

function bodyHasPending(markdown) {
  if (!markdown) return false;
  return parseBlocks(bodyOf(markdown)).blocks.some((block) => isPendingHeading(block.heading));
}

/**
 * 块级三方合并。
 *   - base = HEAD 里的上一版（上次生成 / 上次合并结果）
 *   - ours = 磁盘（可能被人手改）
 *   - theirs = 本次渲染
 *
 * 人改过的块保留 ours，同时把 theirs 的版本记进 `## 待合并`；
 * 上一轮 `## 待合并` 里列过的标签视为「人仍然拥有」，避免下一轮把人的内容覆盖掉。
 * 没有冲突就不产生 `## 待合并`。
 */
function mergeBody(oursBody, baseBody, nextBody, options = {}) {
  const date = options.date ?? dateStamp();
  const ours = parseBlocks(oursBody);
  const base = parseBlocks(baseBody);
  const next = parseBlocks(nextBody);

  const previousLabels = pendingLabelsFrom(base.blocks);
  const oursBlocks = new Map(withoutPending(ours.blocks).map((block) => [block.heading, block.text]));
  const baseBlocks = new Map(withoutPending(base.blocks).map((block) => [block.heading, block.text]));
  const nextBlocks = new Map(withoutPending(next.blocks).map((block) => [block.heading, block.text]));

  const conflicts = [];

  // 描述 = 第一个 `## ` 之前的正文
  const preambleOwned = previousLabels.has('描述') || canon(ours.preamble) !== canon(base.preamble);
  let preamble;
  if (preambleOwned) {
    preamble = ours.preamble;
    if (canon(next.preamble) && canon(next.preamble) !== canon(ours.preamble)) {
      conflicts.push({ label: '描述', text: next.preamble });
    }
  } else {
    preamble = next.preamble;
  }

  const headings = [
    ...withoutPending(next.blocks).map((block) => block.heading),
    ...withoutPending(ours.blocks)
      .map((block) => block.heading)
      .filter((heading) => !nextBlocks.has(heading)),
  ];

  const parts = [];
  for (const heading of headings) {
    const oursText = oursBlocks.get(heading);
    const baseText = baseBlocks.get(heading);
    const nextText = nextBlocks.get(heading);
    // renderTopicMarkdown 只会生成 `## spans` 这一个机器块，其余 `## ` 标题
    // 都是人手工加的段落：即使已经进了 HEAD（被我们提交过），也必须一直保留。
    const humanOnlyBlock = heading !== 'spans' && oursText !== undefined && nextText === undefined;
    const humanOwned = humanOnlyBlock || previousLabels.has(heading) || (
      oursText === undefined
        ? baseText !== undefined // 人删除了块
        : baseText === undefined || canon(oursText) !== canon(baseText) // 人新增 / 人改写
    );

    if (humanOwned) {
      if (oursText !== undefined) parts.push(oursText);
      if (nextText !== undefined && canon(nextText) !== canon(oursText ?? '')) {
        conflicts.push({ label: heading, text: nextText });
      }
    } else if (nextText !== undefined) {
      parts.push(nextText);
    }
  }

  const chunks = [preamble, ...parts].filter((chunk) => chunk && String(chunk).trim() !== '');
  if (conflicts.length) chunks.push(renderPendingSection(conflicts, date));
  return chunks.join('\n\n').trimEnd();
}

/**
 * 无法判断时的兜底：保留人改版本，把本次渲染的正文 / 块全部作为建议
 * 追加到 `## 待合并（日期）`。已有的待合并区会被替换掉。
 */
function pendingMerge(existingContent, renderedMarkdown, options = {}) {
  const date = options.date ?? dateStamp();
  const existing = splitMarkdown(existingContent);
  const next = splitMarkdown(renderedMarkdown);

  const existingBlocks = parseBlocks(existing.body);
  const kept = [
    existingBlocks.preamble,
    ...withoutPending(existingBlocks.blocks).map((block) => block.text),
  ].filter((chunk) => chunk && String(chunk).trim() !== '');

  const nextBlocks = parseBlocks(next.body);
  const conflicts = [];
  if (canon(nextBlocks.preamble)) {
    conflicts.push({ label: '描述', text: nextBlocks.preamble });
  }
  for (const block of withoutPending(nextBlocks.blocks)) {
    conflicts.push({ label: block.heading, text: block.text });
  }

  const chunks = [...kept];
  if (conflicts.length) chunks.push(renderPendingSection(conflicts, date));

  const head = existing.head || next.head;
  return `${head ? `${head}\n` : ''}${chunks.join('\n\n').trimEnd()}\n`;
}

function composeMarkdown(head, body) {
  const cleanHead = head ? `${String(head).replace(/\n+$/, '')}\n` : '';
  const cleanBody = String(body ?? '').replace(/^\n+/, '').trimEnd();
  return cleanHead ? `${cleanHead}\n${cleanBody}\n` : `${cleanBody}\n`;
}

/** body 里第一个 `## ` 之前的内容 = 主题描述。 */
function bodyDescription(markdown) {
  const body = bodyOf(markdown);
  const cut = body.search(/\n## /);
  return (cut === -1 ? body : body.slice(0, cut)).trim();
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
}

function toPosixPath(value) {
  return String(value).split('\\').join('/');
}

/** 路径归一化：realpath（解 symlink / 短路径）+ 正斜杠 + Windows 小写。 */
function normalizePath(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  try {
    text = typeof realpathSync.native === 'function' ? realpathSync.native(text) : realpathSync(text);
  } catch {
    /* 路径可能还不存在：退回 resolve */
  }
  const normalized = resolve(text).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(a, b) {
  return normalizePath(a) === normalizePath(b) && normalizePath(a) !== '';
}

function errorText(err) {
  const stderr = err?.stderr === undefined ? '' : String(err.stderr);
  const stdout = err?.stdout === undefined ? '' : String(err.stdout);
  return oneLine(`${stderr} ${stdout} ${err?.message ?? ''}`).slice(0, 300);
}

function warnGit(message) {
  console.warn(`[topics] ${message}`);
}

/**
 * dir 本身是不是一个独立仓库的根。
 * 注意：`git -C <subdir> rev-parse --show-toplevel` 在 `.dev/topics` 这种
 * 「项目内子目录」上会返回项目根 —— 那种情况必须视为 false，强制 init 嵌套仓库，
 * 绝不复用外层仓库（否则 add/commit 会动到整个项目）。
 */
function isRepoRoot(dir) {
  try {
    const top = String(git(dir, ['rev-parse', '--show-toplevel'])).trim();
    if (!top) return false;
    return samePath(top, dir);
  } catch {
    return false;
  }
}

/** 在 dir 里强制 init 一个独立仓库；失败只告警，不抛。 */
function initOwnRepo(dir) {
  try {
    git(dir, ['init', '-q']);
    return true;
  } catch (err) {
    warnGit(`git 初始化失败，跳过 git 保护（${errorText(err)}）`);
    return false;
  }
}

/**
 * 一次 git status 同时回答两个问题：仓库能不能用、目标文件脏不脏。
 * 失败 → available:false（此时不会去 add/commit）。
 */
function gitState(dir, relativePath) {
  try {
    const out = String(git(dir, ['status', '--porcelain', '--', relativePath])).trim();
    return { available: true, dirty: out !== '' };
  } catch {
    return { available: false, dirty: true };
  }
}

/** HEAD 里的上一版文件内容；没有 commit / 文件未跟踪 → null。 */
function gitShowHead(dir, relativePath) {
  try {
    return String(git(dir, ['show', `HEAD:${relativePath}`]));
  } catch {
    return null;
  }
}

function gitCommit(dir, slug) {
  try {
    // `-- .` 把 add 限定在 topic 目录（-C 之后 `.` 相对于 dir），
    // 绝不 stage 目录之外的东西。
    git(dir, ['add', '-A', '--', '.']);
  } catch (err) {
    warnGit(`git add 失败（${errorText(err)}）`);
    return { ok: false, committed: false };
  }
  try {
    git(dir, [
      '-c', 'user.name=dsh-recall',
      '-c', 'user.email=recall@localhost',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', `curate: ${slug}`,
    ]);
    return { ok: true, committed: true };
  } catch (err) {
    const message = errorText(err);
    if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(message)) {
      return { ok: true, committed: false };
    }
    warnGit(`git commit 失败（${message}）`);
    return { ok: false, committed: false };
  }
}

// ---------------------------------------------------------------------------
// 表读写
// ---------------------------------------------------------------------------

function rowToTopic(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    slug: row.slug,
    title: row.title,
    description: row.description,
    file: row.file,
    span_ids: toArray(row.span_ids).map(String),
    content_hash: row.content_hash ?? null,
    updated_at: row.updated_at,
  };
}

/**
 * 列出主题。span_ids 出库即 JSON.parse 成数组。
 * scope 省略 / 空 → 全部；否则精确过滤。
 */
export function listTopics(db, opts = {}) {
  const scope = opts?.scope === undefined || opts?.scope === null
    ? ''
    : String(opts.scope).trim();
  const rows = scope
    ? db.prepare('SELECT * FROM topics WHERE scope = ? ORDER BY updated_at DESC, rowid DESC').all(scope)
    : db.prepare('SELECT * FROM topics ORDER BY updated_at DESC, rowid DESC').all();
  return rows.map(rowToTopic);
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function topicId() {
  return `tp_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * 写入一个主题：md 文件（含 git 保护）+ topics 表 + 可选向量。
 *
 * @param {object} db
 * @param {object} topic { id?, scope, slug, title, description, span_ids: string[],
 *                         spans?: object[], vec?, vector_model? }
 * @param {{dir?:string}} [opts] dir 覆盖默认目录（测试必须传）
 * @returns {object} topic 行 + { git:boolean, committed:boolean, merge:string }
 */
export function upsertTopic(db, topic, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('upsertTopic: 需要一个 SQLite 数据库实例');
  }
  if (!topic || typeof topic !== 'object') {
    throw new TypeError('upsertTopic: topic 必须是对象');
  }

  const scope = String(topic.scope ?? '').trim() || 'global';
  const slug = topicSlug(topic.slug ?? topic.title ?? 'topic');
  const dir = opts?.dir ? resolve(String(opts.dir)) : defaultTopicDir();
  const file = topicFilePath(dir, scope, slug);
  const now = Date.now();

  const declaredIds = normalizeIdList(topic.span_ids);
  const providedSpans = Array.isArray(topic.spans)
    ? topic.spans.filter((span) => span && typeof span === 'object')
    : [];
  const spanIds = declaredIds.length
    ? declaredIds
    : normalizeIdList(providedSpans.map((span) => span.id));
  const spans = providedSpans.length ? providedSpans : listSpans(db, { ids: spanIds });

  const rendered = renderTopicMarkdown(
    { ...topic, scope, slug, span_ids: spanIds },
    spans,
  );

  mkdirSync(dirname(file), { recursive: true });
  const existingContent = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const relativePath = toPosixPath(relative(dir, file));

  // 先确保 dir 是「独立仓库根」：如果它只是外层项目仓库里的子目录，
  // 强制 init 一个嵌套仓库（合法），绝不复用外层仓库。
  let repo;
  if (isRepoRoot(dir)) {
    repo = gitState(dir, relativePath);
  } else if (initOwnRepo(dir)) {
    // 刚 init 的仓库没有 HEAD，已有文件一律视为脏（untracked）。
    repo = { available: true, dirty: Boolean(existingContent && existingContent.trim()) };
  } else {
    repo = { available: false, dirty: true };
  }

  let content;
  let mergeMode;
  const date = dateStamp(new Date(now));
  // 上一轮没解决的冲突会留下 `## 待合并`：即使 git 是干净的（我们替人提交了），
  // 也不能直接覆盖，否则人会丢掉自己刚写过的东西。
  const pendingExists = bodyHasPending(existingContent);
  if (!repo.available) {
    if (!existingContent || !existingContent.trim() || sameContent(existingContent, rendered)) {
      content = rendered;
      mergeMode = 'write';
    } else {
      content = pendingMerge(existingContent, rendered, { date });
      mergeMode = 'pending';
    }
  } else if (
    (!repo.dirty && !pendingExists)
    || !existingContent
    || !existingContent.trim()
    || sameContent(existingContent, rendered)
  ) {
    content = rendered;
    mergeMode = 'write';
  } else {
    const baseContent = gitShowHead(dir, relativePath);
    if (baseContent === null) {
      content = pendingMerge(existingContent, rendered, { date });
      mergeMode = 'pending';
    } else {
      content = composeMarkdown(
        splitMarkdown(rendered).head,
        mergeBody(bodyOf(existingContent), bodyOf(baseContent), bodyOf(rendered), { date }),
      );
      mergeMode = 'merged';
    }
  }

  const changed = existingContent !== content;
  if (changed) writeFileSync(file, content, 'utf8');

  let gitOk = repo.available;
  let committed = false;
  if (gitOk && changed) {
    const result = gitCommit(dir, slug);
    gitOk = result.ok;
    committed = result.committed;
  }

  const existingRow = db.prepare('SELECT * FROM topics WHERE scope = ? AND slug = ?').get(scope, slug) || null;
  const title = String(topic.title ?? '').trim() || existingRow?.title || slug;
  const description = bodyDescription(content) || String(topic.description ?? '').trim();
  const spanIdsJson = JSON.stringify(spanIds);
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  const providedId = typeof topic.id === 'string' ? topic.id.trim() : '';
  const id = existingRow?.id ?? (providedId || topicId());

  if (existingRow) {
    db.prepare(
      'UPDATE topics SET title = ?, description = ?, file = ?, span_ids = ?, content_hash = ?, updated_at = ? WHERE id = ?',
    ).run(title, description, file, spanIdsJson, contentHash, now, id);
  } else {
    db.prepare(
      `INSERT INTO topics (id, scope, slug, title, description, file, span_ids, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, scope, slug, title, description, file, spanIdsJson, contentHash, now);
  }

  const rawVec = topic.vec ?? topic.vector;
  if (rawVec && (Array.isArray(rawVec) || rawVec instanceof Float32Array) && rawVec.length) {
    try {
      saveTopicVectors(db, [{
        topic_id: id,
        model: topic.vector_model ?? topic.embedding_model ?? 'unknown',
        vec: rawVec,
      }]);
    } catch (err) {
      warnGit(`topic 向量写入失败（${errorText(err)}）`);
    }
  }

  return {
    id,
    scope,
    slug,
    title,
    description,
    file,
    span_ids: spanIds,
    content_hash: contentHash,
    updated_at: now,
    git: gitOk,
    committed,
    merge: mergeMode,
  };
}

export default {
  scopeSlug,
  topicSlug,
  topicFilePath,
  defaultTopicDir,
  listTopics,
  readTopicFile,
  renderTopicMarkdown,
  upsertTopic,
};
