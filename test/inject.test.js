import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core/db.js';
import { insertSpans } from '../src/core/spans.js';
import {
  buildInjection,
  buildInjectionSync,
  createInjectionCache,
  resolveInjection,
} from '../src/plugin/inject.js';

const SCOPE = 'D:\\personal_vibe\\demo';
const QUESTION = 'TTS 情感参数怎么配置';

let topicSeq = 0;

/** 直接写 topics 表（注入只读表，不需要生成 md 文件）。 */
function insertTopic(db, {
  slug,
  title,
  description,
  spanIds = [],
  scope = SCOPE,
  updatedAt = Date.now(),
}) {
  topicSeq += 1;
  db.prepare(
    `INSERT INTO topics (
       id, scope, slug, title, description, file, span_ids, content_hash, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `tp_test_${topicSeq}`,
    scope,
    slug,
    title,
    description,
    `topics/${slug}.md`,
    JSON.stringify(spanIds),
    null,
    updatedAt,
  );
}

/** 有 3 条 span 的 TTS 主题；narrative 也挂在同一主题下。 */
function ttsFixture() {
  const db = openDb(':memory:');
  const { ids } = insertSpans(db, [
    {
      scope: SCOPE,
      type: 'decision',
      text: '决定情感参数走独立配置文件',
      turns: [7],
      evidence: [{ session_id: 's1', seq: 8121, turn: 7 }],
    },
    {
      scope: SCOPE,
      type: 'operation',
      text: '读 12 个文件定位搜索实现',
      turns: [8, 9],
      evidence: [{ session_id: 's1', seq: 8150, turn: 8 }],
    },
    {
      scope: SCOPE,
      type: 'narrative',
      text: '用户描述喜欢的水果和香水',
      turns: [10],
      evidence: [],
    },
  ]);
  insertTopic(db, {
    slug: 'tts-emotion',
    title: 'TTS 情感与显存',
    description: 'TTS 情感参数导致显存溢出的排查、降 batch 与独立配置文件的决定。',
    spanIds: ids,
  });
  return { db, ids };
}

test('buildInjectionSync：没有主题过阈值 → 空文本', () => {
  const db = openDb(':memory:');
  insertTopic(db, {
    slug: 'frontend',
    title: '前端构建',
    description: 'vite 配置与 React 组件拆分',
  });
  // 别的 scope 下即使主题相关，也不能注入到当前项目
  insertTopic(db, {
    slug: 'tts-other',
    title: 'TTS 情感与显存',
    description: 'TTS 情感参数怎么配置',
    scope: 'D:\\personal_vibe\\other',
  });

  const result = buildInjectionSync({ db, scope: SCOPE, question: QUESTION });
  assert.deepEqual(result, { text: '', topicsUsed: [], spansUsed: [] });
  db.close();
});

test('buildInjectionSync：有主题 → 输出格式正确（标题 / span / 轮次）', () => {
  const { db, ids } = ttsFixture();
  const result = buildInjectionSync({ db, scope: SCOPE, question: QUESTION });

  const lines = result.text.split('\n');
  assert.equal(lines[0], '## 相关记忆（dsh-recall）');
  assert.ok(lines.includes('### 主题：TTS 情感与显存'));
  assert.ok(lines.includes('- [decision] 决定情感参数走独立配置文件（第 7 轮）'));
  assert.ok(lines.includes('- [operation] 读 12 个文件定位搜索实现（第 8、9 轮）'));
  assert.ok(lines.includes('- [narrative] 用户描述喜欢的水果和香水（第 10 轮）'));

  // 标题在前，内容行在标题之后
  assert.ok(result.text.indexOf('### 主题') < result.text.indexOf('- [decision]'));

  assert.deepEqual(result.topicsUsed, ['tts-emotion']);
  assert.equal(result.spansUsed.length, 3);
  assert.deepEqual([...result.spansUsed].sort(), [...ids].sort());
  db.close();
});

test('buildInjectionSync：超过 maxLines 截断且总行数 ≤ maxLines', () => {
  const db = openDb(':memory:');
  const spans = Array.from({ length: 250 }, (_, i) => ({
    scope: SCOPE,
    type: 'operation',
    text: `第 ${i + 1} 次操作：TTS 情感参数排查`,
    turns: [i + 1],
    evidence: [],
  }));
  const { ids } = insertSpans(db, spans);
  insertTopic(db, {
    slug: 'tts-emotion',
    title: 'TTS 情感与显存',
    description: 'TTS 情感参数导致显存溢出与独立配置文件的决定',
    spanIds: ids,
  });

  const result = buildInjectionSync({ db, scope: SCOPE, question: QUESTION });
  const lines = result.text.split('\n');
  assert.ok(lines.length <= 200, `实际 ${lines.length} 行`);
  assert.equal(lines.length, 200);
  assert.match(result.text, /已截断/);
  assert.ok(result.spansUsed.length > 0);
  assert.ok(result.spansUsed.length < 250, `spansUsed=${result.spansUsed.length}`);
  assert.deepEqual(result.topicsUsed, ['tts-emotion']);
  db.close();
});

test('buildInjectionSync：maxTopics 限制主题数', () => {
  const db = openDb(':memory:');
  const first = insertSpans(db, [
    { scope: SCOPE, type: 'decision', text: 'TTS 情感参数走配置文件', turns: [3] },
  ]);
  const second = insertSpans(db, [
    { scope: SCOPE, type: 'narrative', text: 'TTS 情感参数与显存排查记录', turns: [5] },
  ]);
  insertTopic(db, {
    slug: 'tts-a',
    title: 'TTS 情感',
    description: 'TTS 情感参数配置',
    spanIds: first.ids,
    updatedAt: Date.now(),
  });
  insertTopic(db, {
    slug: 'tts-b',
    title: 'TTS 显存',
    description: 'TTS 情感参数排查',
    spanIds: second.ids,
    updatedAt: Date.now() + 1,
  });

  const result = buildInjectionSync({ db, scope: SCOPE, question: QUESTION, maxTopics: 1 });
  assert.equal(result.topicsUsed.length, 1);
  db.close();
});

test('buildInjectionSync：空问题 / 无主题 → 空文本，不抛', () => {
  const db = openDb(':memory:');
  assert.deepEqual(buildInjectionSync({ db, scope: SCOPE, question: '' }), {
    text: '',
    topicsUsed: [],
    spansUsed: [],
  });
  assert.deepEqual(buildInjectionSync({ db, scope: SCOPE, question: QUESTION }), {
    text: '',
    topicsUsed: [],
    spansUsed: [],
  });
  // 没有 db 也不能抛
  assert.deepEqual(buildInjectionSync({ scope: SCOPE, question: QUESTION }), {
    text: '',
    topicsUsed: [],
    spansUsed: [],
  });
  db.close();
});

test('buildInjection：没有选择器模型 → 退回同步词法结果', async () => {
  const { db } = ttsFixture();
  const result = await buildInjection({ db, scope: SCOPE, question: QUESTION });
  assert.equal(result.skipped, 'no-selector');
  assert.ok(result.text.includes('## 相关记忆（dsh-recall）'));
  assert.deepEqual(result.topicsUsed, ['tts-emotion']);
  assert.ok(result.spansUsed.length > 0);
  db.close();
});

test('buildInjection：选择器只保留选中的 span', async () => {
  const { db, ids } = ttsFixture();
  let call = 0;
  const complete = async () => {
    call += 1;
    if (call === 1) return { open: ['tts-emotion'] };
    return { selected: [{ span_id: ids[0], why: '直接回答情感参数怎么配' }], skip: false };
  };

  const result = await buildInjection({
    db,
    scope: SCOPE,
    question: QUESTION,
    complete,
    activeTools: ['read'],
  });
  assert.equal(result.skipped, null);
  assert.deepEqual(result.spansUsed, [ids[0]]);
  assert.deepEqual(result.topicsUsed, ['tts-emotion']);
  assert.ok(result.text.includes('决定情感参数走独立配置文件'));
  assert.ok(!result.text.includes('读 12 个文件定位搜索实现'));
  assert.ok(!result.text.includes('用户描述喜欢的水果和香水'));
  db.close();
});

test('buildInjection：选择器 skip / 无问题 → 空结果', async () => {
  const { db } = ttsFixture();
  const skipComplete = async () => ({ open: [] });
  const skipped = await buildInjection({
    db,
    scope: SCOPE,
    question: QUESTION,
    complete: skipComplete,
  });
  assert.equal(skipped.text, '');
  assert.equal(skipped.skipped, 'selector-skip');

  const noQuestion = await buildInjection({ db, scope: SCOPE, question: '' });
  assert.equal(noQuestion.skipped, 'no-question');
  assert.equal(noQuestion.text, '');
  db.close();
});

test('buildInjection：没有主题过阈值 → skipped=no-topic', async () => {
  const db = openDb(':memory:');
  insertTopic(db, {
    slug: 'frontend',
    title: '前端构建',
    description: 'vite 配置与 React 组件拆分',
  });
  const result = await buildInjection({ db, scope: SCOPE, question: QUESTION });
  assert.equal(result.skipped, 'no-topic');
  assert.equal(result.text, '');
  db.close();
});

test('resolveInjection：选择器超时 → 退回同步词法结果', async () => {
  const { db } = ttsFixture();
  let calls = 0;
  // 选择器永远不返回：模拟模型卡住
  const complete = async () => {
    calls += 1;
    return new Promise(() => {});
  };

  const result = await resolveInjection({
    db,
    scope: SCOPE,
    question: QUESTION,
    complete,
    timeoutMs: 30,
  });

  assert.equal(result.skipped, 'selector-timeout');
  assert.ok(result.text.includes('## 相关记忆（dsh-recall）'), '超时必须给同步词法兜底');
  assert.deepEqual(result.topicsUsed, ['tts-emotion']);
  assert.ok(result.spansUsed.length > 0);
  assert.equal(calls, 1);
  db.close();
});

test('resolveInjection：同一 cacheKey 命中缓存，不重复调用模型', async () => {
  const { db, ids } = ttsFixture();
  let calls = 0;
  const complete = async () => {
    calls += 1;
    if (calls === 1) return { open: ['tts-emotion'] };
    return { selected: [{ span_id: ids[0], why: '直接回答' }], skip: false };
  };
  const cache = createInjectionCache();
  const options = {
    db,
    scope: SCOPE,
    question: QUESTION,
    complete,
    cache,
    cacheKey: 's1:1',
  };

  const first = await resolveInjection(options);
  assert.equal(first.cached, undefined);
  assert.equal(calls, 2, '一次选择器 = 两次模型调用');
  assert.deepEqual(first.spansUsed, [ids[0]]);

  const second = await resolveInjection(options);
  assert.equal(calls, 2, '命中缓存后不能再调模型');
  assert.equal(second.cached, true);
  assert.equal(second.text, first.text);
  assert.deepEqual(second.spansUsed, first.spansUsed);

  // 新输入（claim）会让调用方按会话前缀清缓存
  assert.equal(cache.deleteByPrefix('s1:'), 1);
  assert.equal(cache.size, 0);
  db.close();
});
