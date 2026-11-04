import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { openDb } from '../src/core/db.js';
import { insertSpans } from '../src/core/spans.js';
import {
  defaultTopicDir,
  listTopics,
  readTopicFile,
  renderTopicMarkdown,
  scopeSlug,
  topicFilePath,
  topicSlug,
  upsertTopic,
} from '../src/core/topics.js';

const SCOPE = 'D:\\personal_vibe\\dsh-recall';
const OTHER_SCOPE = 'D:\\personal_vibe\\other';

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-topics-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function read(file) {
  return readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// 渲染 / 解析
// ---------------------------------------------------------------------------

test('renderTopicMarkdown：frontmatter + 描述 + ## spans 与 design-v2 第 5 节一致', () => {
  const topic = {
    title: 'TTS 情感与显存',
    description: '这个主题收了 5 条：情感参数导致显存溢出的排查、降 batch 的决定。',
    span_ids: ['sp_1', 'sp_2'],
    updated_at: Date.parse('2026-11-05T00:00:00.000Z'),
  };
  const spans = [
    { id: 'sp_1', type: 'decision', text: '决定情感参数走独立配置文件', turns: [7] },
    { id: 'sp_2', type: 'operation', text: '读 12 个文件定位搜索实现', turns: [8, 9] },
  ];

  const markdown = renderTopicMarkdown(topic, spans);
  assert.ok(markdown.startsWith(
    '---\ntitle: TTS 情感与显存\nupdated: 2026-11-05T00:00:00.000Z\nspans:\n  - sp_1\n  - sp_2\n---\n',
  ));
  assert.match(markdown, /## spans\n- \[decision\] 决定情感参数走独立配置文件（turns 7）\n/);
  assert.match(markdown, /- \[operation\] 读 12 个文件定位搜索实现（turns 8,9）\n$/);
  assert.ok(markdown.endsWith('\n'));

  // spans 为空时显式写 []
  const empty = renderTopicMarkdown({ title: '空主题', description: '暂无' }, []);
  assert.match(empty, /\nspans: \[\]\n/);
});

test('readTopicFile：渲染 → 解析回来一致（title / updated / spans / body）', (t) => {
  const dir = makeDir(t);
  const topic = {
    title: 'TTS 情感与显存',
    description: '这个主题收了 5 条：情感参数导致显存溢出的排查。',
    span_ids: ['sp_1', 'sp_2'],
    updated_at: Date.parse('2026-11-05T00:00:00.000Z'),
  };
  const spans = [
    { id: 'sp_1', type: 'decision', text: '决定情感参数走独立配置文件', turns: [7] },
    { id: 'sp_2', type: 'operation', text: '读 12 个文件定位搜索实现', turns: [8, 9] },
  ];
  const file = join(dir, 'roundtrip.md');
  writeFileSync(file, renderTopicMarkdown(topic, spans));

  const parsed = readTopicFile(file);
  assert.equal(parsed.path, file);
  assert.equal(parsed.title, topic.title);
  assert.equal(parsed.updated, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(parsed.spans, topic.span_ids);
  assert.ok(parsed.body.startsWith(topic.description));
  assert.match(parsed.body, /## spans/);
  assert.match(parsed.body, /（turns 8,9）/);
  assert.equal(parsed.frontmatter.title, topic.title);
});

test('readTopicFile：无 frontmatter / 引号值 / CRLF 都能解析', (t) => {
  const dir = makeDir(t);

  const plain = join(dir, 'plain.md');
  writeFileSync(plain, '纯文本\n## spans\n- [narrative] x');
  const parsed = readTopicFile(plain);
  assert.equal(parsed.title, null);
  assert.deepEqual(parsed.spans, []);
  assert.equal(parsed.frontmatter.title, undefined);
  assert.ok(parsed.body.startsWith('纯文本'));

  const quoted = join(dir, 'quoted.md');
  writeFileSync(quoted, '---\ntitle: "带 引号"\nupdated: 2026-01-02T03:04:05.000Z\nspans:\n  - sp_9\n---\n\n正文\n');
  const quotedParsed = readTopicFile(quoted);
  assert.equal(quotedParsed.title, '带 引号');
  assert.deepEqual(quotedParsed.spans, ['sp_9']);
  assert.equal(quotedParsed.body, '正文');

  const topic = { title: '含内部引号 "x"', description: 'CRLF 描述', span_ids: ['sp_1'] };
  const crlf = join(dir, 'crlf.md');
  writeFileSync(crlf, renderTopicMarkdown(topic, []).replaceAll('\n', '\r\n'));
  const crlfParsed = readTopicFile(crlf);
  assert.equal(crlfParsed.title, '含内部引号 "x"');
  assert.deepEqual(crlfParsed.spans, ['sp_1']);
  assert.match(crlfParsed.body, /CRLF 描述/);
});

// ---------------------------------------------------------------------------
// slug / 路径规则
// ---------------------------------------------------------------------------

test('scopeSlug / topicSlug：非字母数字换 -、截断 60、空值兜底', () => {
  assert.equal(scopeSlug('D:\\personal_vibe\\dsh-recall'), 'D-personal-vibe-dsh-recall');
  assert.equal(scopeSlug('/home/user/proj'), 'home-user-proj');
  assert.equal(scopeSlug('C:\\a b\\c'), 'C-a-b-c');
  assert.equal(scopeSlug(''), 'global');
  assert.equal(scopeSlug('   '), 'global');
  assert.equal(scopeSlug('项目'), 'global');

  const long = scopeSlug('a'.repeat(80));
  assert.equal(long.length, 60);
  assert.equal(long, 'a'.repeat(60));
  // 截断后不能留下结尾 '-'
  assert.equal(scopeSlug(`${'a'.repeat(59)}-b`), 'a'.repeat(59));

  assert.equal(topicSlug('TTS Emotion'), 'tts-emotion');
  assert.equal(topicSlug('  TTS/emotion!!  '), 'tts-emotion');
  assert.equal(topicSlug(''), 'topic');
  assert.equal(topicSlug('中文'), 'topic');

  assert.equal(
    topicFilePath('/tmp/topics', 'D:\\personal_vibe\\dsh-recall', 'tts-emotion'),
    join(resolve('/tmp/topics'), 'D-personal-vibe-dsh-recall', 'tts-emotion.md'),
  );
});

test('defaultTopicDir：dir 参数以外，环境变量优先于 ~/.dsh/recall/topics', () => {
  assert.ok(defaultTopicDir({}).endsWith(join('.dsh', 'recall', 'topics')));
  assert.equal(
    defaultTopicDir({ DSH_RECALL_TOPIC_DIR: 'D:\\configured\\topics' }),
    resolve('D:\\configured\\topics'),
  );
});

// ---------------------------------------------------------------------------
// upsertTopic：写文件 + 落表 + git
// ---------------------------------------------------------------------------

test('upsertTopic：写 md、落 topics 表、git init + commit', (t) => {
  const db = makeDb(t);
  const dir = makeDir(t);
  const { ids } = insertSpans(db, [
    { scope: SCOPE, type: 'decision', text: '决定 TTS 情感参数走独立配置文件', turns: [7] },
    { scope: SCOPE, type: 'operation', text: '读 agent_search 仓库 12 个文件', turns: [8, 9] },
  ]);

  const result = upsertTopic(db, {
    scope: SCOPE,
    slug: 'tts-emotion',
    title: 'TTS 情感与显存',
    description: '模型描述：情感参数导致显存溢出，决定降 batch。',
    span_ids: ids,
  }, { dir });

  assert.equal(result.git, true);
  assert.equal(result.committed, true);
  assert.equal(result.merge, 'write');
  assert.match(result.id, /^tp_[0-9a-f]{12}$/);
  assert.equal(
    result.file,
    join(dir, 'D-personal-vibe-dsh-recall', 'tts-emotion.md'),
  );
  assert.ok(existsSync(result.file));
  assert.ok(existsSync(join(dir, '.git')), '不是仓库时会 git init');

  const parsed = readTopicFile(result.file);
  assert.equal(parsed.title, 'TTS 情感与显存');
  assert.deepEqual(parsed.spans, ids);
  assert.match(parsed.body, /模型描述：情感参数导致显存溢出/);
  assert.match(parsed.body, /\[decision\] 决定 TTS 情感参数走独立配置文件（turns 7）/);
  assert.match(parsed.body, /\[operation\] 读 agent_search 仓库 12 个文件（turns 8,9）/);

  const rows = listTopics(db, { scope: SCOPE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, result.id);
  assert.equal(rows[0].description, '模型描述：情感参数导致显存溢出，决定降 batch。');
  assert.deepEqual(rows[0].span_ids, ids, 'span_ids 出库必须是数组');
  assert.equal(rows[0].content_hash, result.content_hash);
  assert.equal(rows[0].file, result.file);

  const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).trim();
  assert.match(log, /curate: tts-emotion/);
});

test('upsertTopic：没有手改时直接覆盖，同一主题复用 id 与文件', (t) => {
  const db = makeDb(t);
  const dir = makeDir(t);
  const spans = [{ id: 'sp_1', type: 'decision', text: '第一版 span', turns: [1] }];

  const first = upsertTopic(db, {
    scope: SCOPE,
    slug: 'overwrite',
    title: '覆盖测试',
    description: '第一版描述',
    spans,
  }, { dir });
  assert.equal(first.merge, 'write');

  const second = upsertTopic(db, {
    scope: SCOPE,
    slug: 'overwrite',
    title: '覆盖测试',
    description: '第二版描述',
    spans,
  }, { dir });

  assert.equal(second.id, first.id);
  assert.equal(second.file, first.file);
  assert.equal(second.merge, 'write');
  const content = read(second.file);
  assert.match(content, /第二版描述/);
  assert.ok(!content.includes('第一版描述'));
  assert.ok(!content.includes('## 待合并'), '没有手改冲突时不应出现待合并区');
  assert.equal(listTopics(db, { scope: SCOPE }).length, 1);
});

test('upsertTopic：手改描述会保留，模型新描述进 ## 待合并（每次覆盖最新）', (t) => {
  const db = makeDb(t);
  const dir = makeDir(t);
  const { ids } = insertSpans(db, [
    { scope: SCOPE, type: 'decision', text: '决定 TTS 情感参数走独立配置文件', turns: [7] },
    { scope: SCOPE, type: 'operation', text: '读 agent_search 仓库 12 个文件', turns: [8, 9] },
  ]);

  const first = upsertTopic(db, {
    scope: SCOPE,
    slug: 'tts-emotion',
    title: 'TTS 情感与显存',
    description: 'v1 描述',
    span_ids: [ids[0]],
  }, { dir });
  assert.equal(first.merge, 'write');

  // 人改：在描述后面补充一句，并加自己的段落
  let edited = read(first.file);
  edited = edited.replace('v1 描述', 'v1 描述（我手工补充：CI 只认 pnpm-lock）');
  edited += '\n## 人工笔记\n\n这条是手写的，不要删。\n';
  writeFileSync(first.file, edited, 'utf8');

  const second = upsertTopic(db, {
    scope: SCOPE,
    slug: 'tts-emotion',
    title: 'TTS 情感与显存',
    description: 'v2 描述，模型重写',
    span_ids: ids,
  }, { dir });

  assert.equal(second.merge, 'merged');
  assert.equal(second.git, true);
  assert.equal(second.committed, true);

  const merged = read(second.file);
  assert.match(merged, /v1 描述（我手工补充：CI 只认 pnpm-lock）/, '人改的描述要保留');
  assert.match(merged, /## 待合并（\d{4}-\d{2}-\d{2}）/, '冲突要落进待合并区');
  assert.match(merged, /模型建议的新描述：v2 描述，模型重写/, '模型新描述不能静默丢弃');
  assert.ok(
    merged.indexOf('v1 描述（我手工补充') < merged.indexOf('## 待合并'),
    '人改的正文在待合并区之前',
  );
  assert.match(merged, /## 人工笔记/);
  assert.match(merged, /这条是手写的，不要删。/, '人手加的段落要保留');
  assert.match(merged, /读 agent_search 仓库 12 个文件（turns 8,9）/, '没被手改的 spans 块要跟随模型更新');

  // 再跑一次：文件已是干净状态（我们替人提交过），但待合并区还在
  const third = upsertTopic(db, {
    scope: SCOPE,
    slug: 'tts-emotion',
    title: 'TTS 情感与显存',
    description: 'v3 描述，再次重写',
    span_ids: ids,
  }, { dir });

  assert.equal(third.merge, 'merged');
  const mergedAgain = read(third.file);
  assert.match(mergedAgain, /v1 描述（我手工补充：CI 只认 pnpm-lock）/, '人改内容跨多轮保留');
  assert.match(mergedAgain, /模型建议的新描述：v3 描述，再次重写/);
  assert.ok(!mergedAgain.includes('v2 描述，模型重写'), '待合并区只保留最新一次建议');
  assert.equal((mergedAgain.match(/## 待合并/g) ?? []).length, 1, '待合并区不能堆积');
  assert.match(mergedAgain, /## 人工笔记/, '人加段落跨多轮保留');

  const rows = listTopics(db, { scope: SCOPE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'v1 描述（我手工补充：CI 只认 pnpm-lock）');
});

test('upsertTopic：无法判断（未跟踪文件、没有 HEAD）→ 保留人改版本 + ## 待合并', (t) => {
  const db = makeDb(t);
  const dir = makeDir(t);
  const file = topicFilePath(dir, SCOPE, 'hand-made');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '---\ntitle: 人工主题\nspans: []\n---\n\n人工写的内容\n', 'utf8');

  const { ids } = insertSpans(db, [
    { scope: SCOPE, type: 'narrative', text: '模型抽出的 span', turns: [3] },
  ]);
  const result = upsertTopic(db, {
    scope: SCOPE,
    slug: 'hand-made',
    title: '模型标题',
    description: '模型描述文本',
    span_ids: ids,
  }, { dir });

  assert.equal(result.merge, 'pending');
  assert.equal(result.git, true);
  const content = read(result.file);
  assert.ok(content.startsWith('---\ntitle: 人工主题'), '人写的 frontmatter 保留');
  assert.match(content, /人工写的内容/);
  assert.match(content, /## 待合并（\d{4}-\d{2}-\d{2}）/);
  assert.match(content, /模型描述文本/);
  assert.match(content, /### spans/, '模型内容降一级标题追加，避免同名块冲突');
});

test('upsertTopic：git 不可用时只告警不抛，文件照写', (t) => {
  const db = makeDb(t);
  const dir = makeDir(t);
  // 一个假的 .git 会让 rev-parse 和 git init 都失败
  writeFileSync(join(dir, '.git'), 'this is not a git dir\n', 'utf8');

  const spans = [{ id: 'sp_1', type: 'decision', text: '一个 span', turns: [1] }];
  const first = upsertTopic(db, {
    scope: SCOPE,
    slug: 'no-git',
    title: '无 git',
    description: '第一版描述',
    spans,
  }, { dir });

  assert.equal(first.git, false);
  assert.equal(first.committed, false);
  assert.equal(first.merge, 'write');
  assert.ok(existsSync(first.file));
  assert.match(read(first.file), /第一版描述/);

  const second = upsertTopic(db, {
    scope: SCOPE,
    slug: 'no-git',
    title: '无 git',
    description: '第二版描述',
    spans,
  }, { dir });
  assert.equal(second.git, false);
  assert.equal(second.merge, 'pending');
  const content = read(second.file);
  assert.match(content, /第一版描述/);
  assert.match(content, /## 待合并（\d{4}-\d{2}-\d{2}）/);
  assert.match(content, /模型建议的新描述：第二版描述/);
  assert.equal((content.match(/## 待合并/g) ?? []).length, 1);
});

test('listTopics：scope 精确过滤，span_ids 解析成数组', (t) => {
  const db = makeDb(t);
  const dir = makeDir(t);

  upsertTopic(db, {
    scope: SCOPE,
    slug: 'a',
    title: 'A',
    description: 'a',
    spans: [{ id: 'sp_a', type: 'decision', text: 'A', turns: [1] }],
  }, { dir });
  // 另一个 scope 直接落表即可，不必再跑一次 git
  db.prepare(
    `INSERT INTO topics (id, scope, slug, title, description, file, span_ids, updated_at)
     VALUES ('tp_b', ?, 'a', 'A2', 'a2', '/tmp/b.md', '["sp_b"]', 1)`,
  ).run(OTHER_SCOPE);

  const scoped = listTopics(db, { scope: SCOPE });
  assert.equal(scoped.length, 1);
  assert.deepEqual(scoped[0].span_ids, ['sp_a']);
  assert.equal(Array.isArray(scoped[0].span_ids), true);

  assert.equal(listTopics(db).length, 2);
  assert.deepEqual(listTopics(db, { scope: OTHER_SCOPE })[0].span_ids, ['sp_b']);
});
