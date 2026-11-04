import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_OPEN_TOPICS, MAX_WHY_CHARS, selectSpans } from '../src/core/selector.js';

const TOPICS = [
  { slug: 'tts-emotion', title: 'TTS 情感与显存', description: '情感参数导致显存溢出的排查与决定' },
  { slug: 'memory-plugin', title: '记忆插件', description: 'span / topic 地图层的设计与实现' },
];

const SPANS = {
  'tts-emotion': [{
    id: 'sp_1',
    type: 'decision',
    text: '决定情感参数走独立配置文件',
    turns: [7],
  }],
  'memory-plugin': [{
    id: 'sp_2',
    type: 'operation',
    text: '读 spans.js 与 topics.js，接入整理管线',
    turns: [8, 9],
  }],
};

/** 队列式 complete：元素可以是返回值、Error 或函数；用完后重复最后一个。 */
function fakeComplete(responses, calls = []) {
  const queue = Array.isArray(responses) ? responses : [responses];
  let index = 0;
  return async (messages) => {
    calls.push(messages);
    const response = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(messages) : response;
  };
}

function fakeOpenTopic(spansBySlug = SPANS, calls = []) {
  return async (slug) => {
    calls.push(slug);
    const value = spansBySlug[slug];
    if (value instanceof Error) throw value;
    return value ?? [];
  };
}

// ---------------------------------------------------------------------------
// 正常两阶段
// ---------------------------------------------------------------------------

test('selectSpans：两阶段流程（先 open 再 selected），prompt 带问题/工具/主题/span', async () => {
  const calls = [];
  const openCalls = [];
  const complete = fakeComplete([
    { open: ['tts-emotion', 'memory-plugin'] },
    {
      selected: [
        { span_id: 'sp_1', why: '直接回答了情感参数怎么配' },
        { span_id: 'sp_2', why: '说明了整理管线的实现方式' },
      ],
      skip: false,
    },
  ], calls);
  const openTopic = fakeOpenTopic(SPANS, openCalls);

  const result = await selectSpans({
    question: '情感参数怎么配？',
    topics: TOPICS,
    activeTools: ['read', 'grep'],
    complete,
    openTopic,
  });

  assert.deepEqual(result, {
    selected: [
      { span_id: 'sp_1', why: '直接回答了情感参数怎么配' },
      { span_id: 'sp_2', why: '说明了整理管线的实现方式' },
    ],
    skip: false,
    openedTopics: ['tts-emotion', 'memory-plugin'],
  });
  assert.equal(calls.length, 2, '两次模型调用');
  assert.deepEqual(openCalls, ['tts-emotion', 'memory-plugin']);

  // 第一阶段 prompt
  assert.match(calls[0][0].content, /最多打开 4 个主题/);
  assert.match(calls[0][0].content, /只输出 JSON/);
  assert.match(calls[0][1].content, /情感参数怎么配/);
  assert.match(calls[0][1].content, /read, grep/);
  assert.match(calls[0][1].content, /tts-emotion \| TTS 情感与显存/);

  // 第二阶段 prompt
  assert.match(calls[1][0].content, /span_id 必须从下面列表里选/);
  assert.match(calls[1][0].content, /≤60 字/);
  assert.match(calls[1][1].content, /sp_1 \| decision/);
  assert.match(calls[1][1].content, /决定情感参数走独立配置文件/);
  assert.match(calls[1][1].content, /已打开主题：tts-emotion, memory-plugin/);
});

test('selectSpans：没打开任何主题 -> skip=true、openedTopics=[]、不调第二次模型', async () => {
  const calls = [];
  const openCalls = [];
  const complete = fakeComplete([{ open: [] }], calls);

  const result = await selectSpans({
    question: '今天天气怎么样？',
    topics: TOPICS,
    activeTools: [],
    complete,
    openTopic: fakeOpenTopic(SPANS, openCalls),
  });

  assert.deepEqual(result, { selected: [], skip: true, openedTopics: [] });
  assert.equal(calls.length, 1);
  assert.equal(openCalls.length, 0);
});

test('selectSpans：打开的主题没有 span -> skip=true，且不调选择模型', async () => {
  const calls = [];
  const complete = fakeComplete([{ open: ['tts-emotion'] }], calls);

  const result = await selectSpans({
    question: '情感参数怎么配？',
    topics: TOPICS,
    complete,
    openTopic: async () => [],
  });

  assert.deepEqual(result, { selected: [], skip: true, openedTopics: ['tts-emotion'] });
  assert.equal(calls.length, 1, '没有 span 就不该调第二次模型');
});

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

test('selectSpans：非法 span_id 被过滤、why 截断到 60 字、重复 span_id 只留一条', async () => {
  const complete = fakeComplete([
    { open: ['tts-emotion'] },
    {
      selected: [
        { span_id: 'sp_ghost', why: '编造的 span' },
        { span_id: 'sp_1', why: '有'.repeat(100) },
        { span_id: 'sp_1', why: '重复条目' },
      ],
      skip: false,
    },
  ]);

  const result = await selectSpans({
    question: '情感参数怎么配？',
    topics: TOPICS,
    complete,
    openTopic: fakeOpenTopic(),
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].span_id, 'sp_1');
  assert.equal(Array.from(result.selected[0].why).length, MAX_WHY_CHARS);
  assert.equal(result.skip, false);
});

test('selectSpans：最多打开 4 个主题，候选里没有的 slug 被忽略', async () => {
  const topics = Array.from({ length: 6 }, (_, index) => ({
    slug: `topic-${index + 1}`,
    title: `主题 ${index + 1}`,
    description: `描述 ${index + 1}`,
  }));
  const spansBySlug = Object.fromEntries(topics.map((topic, index) => [
    topic.slug,
    [{ id: `sp_${index + 1}`, type: 'narrative', text: `内容 ${index + 1}`, turns: [index + 1] }],
  ]));

  const calls = [];
  const openCalls = [];
  const complete = fakeComplete([
    { open: [...topics.map((topic) => topic.slug), 'spoofed-topic'] },
    { selected: [{ span_id: 'sp_1', why: '有用' }], skip: false },
  ], calls);

  const result = await selectSpans({
    question: '问题',
    topics,
    complete,
    openTopic: fakeOpenTopic(spansBySlug, openCalls),
  });

  assert.equal(result.openedTopics.length, MAX_OPEN_TOPICS);
  assert.deepEqual(openCalls, ['topic-1', 'topic-2', 'topic-3', 'topic-4']);
  assert.ok(!result.openedTopics.includes('spoofed-topic'));
});

// ---------------------------------------------------------------------------
// 容错
// ---------------------------------------------------------------------------

test('selectSpans：某个 openTopic 抛错 -> 只跳过该主题', async () => {
  const complete = fakeComplete([
    { open: ['tts-emotion', 'memory-plugin'] },
    { selected: [{ span_id: 'sp_2', why: '唯一可用' }], skip: false },
  ]);
  const openCalls = [];
  const openTopic = fakeOpenTopic({
    'tts-emotion': new Error('topic file missing'),
    'memory-plugin': SPANS['memory-plugin'],
  }, openCalls);

  const result = await selectSpans({
    question: '记忆插件怎么实现的？',
    topics: TOPICS,
    complete,
    openTopic,
  });

  assert.deepEqual(result.openedTopics, ['memory-plugin']);
  assert.deepEqual(result.selected, [{ span_id: 'sp_2', why: '唯一可用' }]);
  assert.equal(result.skip, false);
  assert.equal(openCalls.length, 2);
});

test('selectSpans：第二阶段模型失败 -> 返回空、skip=true、不抛', async () => {
  const complete = fakeComplete([
    { open: ['tts-emotion'] },
    new Error('select model down'),
  ]);

  const result = await selectSpans({
    question: '情感参数怎么配？',
    topics: TOPICS,
    complete,
    openTopic: fakeOpenTopic(),
  });

  assert.deepEqual(result, { selected: [], skip: true, openedTopics: ['tts-emotion'] });
});

test('selectSpans：第一阶段模型失败 -> 返回空、不调 openTopic、不抛', async () => {
  const complete = fakeComplete([new Error('open model down')]);
  const openCalls = [];

  const result = await selectSpans({
    question: '情感参数怎么配？',
    topics: TOPICS,
    complete,
    openTopic: fakeOpenTopic(SPANS, openCalls),
  });

  assert.deepEqual(result, { selected: [], skip: true, openedTopics: [] });
  assert.equal(openCalls.length, 0);
});

test('selectSpans：模型返回坏 JSON -> 空结果，不抛', async () => {
  const noOpen = await selectSpans({
    question: '问题',
    topics: TOPICS,
    complete: fakeComplete(['这不是 JSON']),
    openTopic: fakeOpenTopic(),
  });
  assert.deepEqual(noOpen, { selected: [], skip: true, openedTopics: [] });

  const badSelect = await selectSpans({
    question: '问题',
    topics: TOPICS,
    complete: fakeComplete([{ open: ['tts-emotion'] }, '也不是 JSON']),
    openTopic: fakeOpenTopic(),
  });
  assert.deepEqual(badSelect, { selected: [], skip: true, openedTopics: ['tts-emotion'] });
});

test('selectSpans：模型 skip=true 被尊重', async () => {
  const complete = fakeComplete([
    { open: ['tts-emotion'] },
    { selected: [], skip: true },
  ]);

  const result = await selectSpans({
    question: '情感参数怎么配？',
    topics: TOPICS,
    complete,
    openTopic: fakeOpenTopic(),
  });

  assert.equal(result.skip, true);
  assert.deepEqual(result.selected, []);
});

test('selectSpans：没有候选主题 / 空问题 / 缺回调 -> 空结果且不调模型', async () => {
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return { open: [] };
  };

  assert.deepEqual(
    await selectSpans({ question: '问题', topics: [], complete, openTopic: async () => [] }),
    { selected: [], skip: true, openedTopics: [] },
  );
  assert.deepEqual(
    await selectSpans({ question: '   ', topics: TOPICS, complete, openTopic: async () => [] }),
    { selected: [], skip: true, openedTopics: [] },
  );
  assert.deepEqual(
    await selectSpans({ question: '问题', topics: TOPICS, complete }),
    { selected: [], skip: true, openedTopics: [] },
  );
  assert.equal(calls, 0);
});

test('selectSpans：候选主题去重并限制为 8 个', async () => {
  const topics = Array.from({ length: 10 }, (_, index) => ({
    slug: `topic-${index + 1}`,
    title: `主题 ${index + 1}`,
    description: '',
  }));
  topics.push({ slug: 'topic-1', title: '重复' });

  const calls = [];
  const complete = fakeComplete([{ open: [] }], calls);
  await selectSpans({ question: '问题', topics, complete, openTopic: async () => [] });

  const prompt = calls[0][1].content;
  assert.match(prompt, /topic-8/);
  assert.doesNotMatch(prompt, /topic-9/, '最多 8 个候选进入选择器');
  assert.equal((prompt.match(/topic-1/g) ?? []).length, 1, '重复 slug 只出现一次');
});
