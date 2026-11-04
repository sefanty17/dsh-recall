import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/core/db.js';
import {
  buildSpanMessages,
  buildTopicMessages,
  curateBatch,
  curateSession,
  groupTurns,
  parseSpans,
  parseTopics,
} from '../src/core/curator.js';
import { insertSpans } from '../src/core/spans.js';
import { listTopics, upsertTopic } from '../src/core/topics.js';

const SCOPE = 'D:\\personal_vibe\\demo';

const TURNS = [
  {
    turn: 7,
    events: [
      { seq: 8121, type: 'user/message', role: 'user', text: 'TTS 情感参数一开就爆显存。' },
      {
        seq: 8122,
        type: 'assistant/message',
        role: 'assistant',
        text: '先看看当前显存占用。',
        thinking: '可能是 batch 太大。',
      },
      { seq: 8123, type: 'tool/call', role: 'tool', tool: 'read', args: '{"file_path":"tts.js"}' },
      { seq: 8124, type: 'tool/result', role: 'tool', output: 'const emotion = {...}' },
    ],
  },
  {
    turn: 8,
    events: [
      { seq: 8150, type: 'user/message', role: 'user', text: '那就把情感参数拆到配置文件。' },
      { seq: 8151, type: 'assistant/message', role: 'assistant', text: '好，改成独立配置文件。' },
    ],
  },
];

const OPERATION_SPAN = {
  type: 'operation',
  text: '读 tts.js 与显存日志，定位情感参数导致显存溢出',
  turns: [7, 8],
  evidence: [{ seq: 8123, turn: 7 }, { seq: 8150, turn: 8 }],
  rationale_from: 'tool',
};

const TOPIC_SLUG = 'tts-emotion';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recall-curator-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function count(db, sql, params = []) {
  return Number(db.prepare(sql).get(...params).n);
}

/**
 * 队列式 complete：数组元素可以是返回值、Error（抛出）或函数（惰性生成）。
 * 数组用完后重复最后一个。
 */
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

/** 从主题归组 prompt 里抠出本次新增 span 的 id。 */
function newSpanIdsFromPrompt(messages) {
  const user = messages?.[1]?.content ?? '';
  return [...user.matchAll(/^- (sp_[^\s|]+) \|/gm)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test('buildSpanMessages：design 3.1 的关键规则全部写进 system prompt，且 ≤800 字', () => {
  const messages = buildSpanMessages({ turns: TURNS, scope: SCOPE, sessionId: 'sess-1' });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');

  const system = messages[0].content;
  assert.match(system, /真实时间顺序/);
  assert.match(system, /同一个 step/);
  assert.match(system, /相邻且中间没有实质内容的 step/);
  assert.match(system, /水果和香水/);
  assert.match(system, /跨轮合并/);
  assert.match(system, /user\|assistant\|reasoning\|tool/);
  assert.match(system, /decision\|operation\|narrative/);
  assert.match(system, /\{"spans":\[\]\}/);
  assert.ok(Array.from(system).length <= 800, 'system prompt 必须 ≤800 字');

  const user = messages[1].content;
  assert.match(user, /项目：D:\\personal_vibe\\demo/);
  assert.match(user, /会话：sess-1/);
  assert.match(user, /第 7 轮/);
  assert.match(user, /第 8 轮/);
  assert.match(user, /seq 8121/);
  assert.match(user, /思考：可能是 batch 太大/);
  assert.match(user, /工具调用：read/);
  assert.match(user, /工具结果：/);
});

test('buildSpanMessages：thinking 截断 800 字，未知类型不渲染', () => {
  const messages = buildSpanMessages({
    turns: [{
      turn: 1,
      events: [
        { seq: 1, type: 'assistant/message', role: 'assistant', text: '正文', thinking: 'x'.repeat(1000) },
        { seq: 2, type: 'system/message', role: 'system', text: '不该出现' },
      ],
    }],
  });
  const user = messages[1].content;
  assert.ok(user.includes('x'.repeat(800)));
  assert.ok(!user.includes('x'.repeat(801)));
  assert.doesNotMatch(user, /不该出现/);
});

// ---------------------------------------------------------------------------
// span 解析
// ---------------------------------------------------------------------------

test('parseSpans：合法条目保留；坏 type/空 text/超长/越界 turn/越界 evidence 全部丢弃', () => {
  const payload = {
    spans: [
      {
        type: 'decision',
        text: '决定情感参数走独立配置文件',
        turns: [7],
        evidence: [{ seq: 8121, turn: 7 }],
        rationale_from: 'reasoning',
      },
      { type: 'feeling', text: 'bad type', turns: [7], evidence: [{ seq: 8121, turn: 7 }] },
      { type: 'narrative', text: '   ', turns: [7], evidence: [{ seq: 8121, turn: 7 }] },
      {
        type: 'narrative',
        text: '长'.repeat(501),
        turns: [7],
        evidence: [{ seq: 8121, turn: 7 }],
      },
      { type: 'narrative', text: '越界轮次', turns: [99], evidence: [{ seq: 8121, turn: 7 }] },
      { type: 'narrative', text: '越界 seq', turns: [7], evidence: [{ seq: 9999, turn: 7 }] },
      { type: 'narrative', text: '跨轮证据', turns: [7], evidence: [{ seq: 8150, turn: 8 }] },
      {
        type: 'operation',
        text: '读文件并定位问题',
        turns: [8, 7],
        evidence: [{ seq: 8150, turn: 8 }, { seq: 8124, turn: 7 }],
        rationale_from: 'vibes',
      },
    ],
  };

  const { spans, rejected } = parseSpans(payload, { turns: TURNS });
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((span) => span.type), ['decision', 'operation']);

  assert.deepEqual(spans[0].turns, [7]);
  assert.equal(spans[0].rationale_from, 'reasoning');

  // turns/evidence 都归一化成升序；非法 rationale_from -> null
  assert.deepEqual(spans[1].turns, [7, 8]);
  assert.deepEqual(spans[1].evidence, [
    { seq: 8124, turn: 7 },
    { seq: 8150, turn: 8 },
  ]);
  assert.equal(spans[1].rationale_from, null);

  assert.deepEqual(
    rejected.map((item) => item.reason),
    [
      'bad_type',
      'empty_text',
      'text_too_long',
      'turn_not_found',
      'evidence_not_found',
      'evidence_not_found',
    ],
  );
});

test('parseSpans：接受 ```json 围栏字符串；evidence 缺省按空数组处理', () => {
  const payload = {
    spans: [{ type: 'narrative', text: '用户描述喜欢的水果和香水类型', turns: [7] }],
  };
  const raw = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
  const { spans, rejected } = parseSpans(raw, { turns: TURNS });
  assert.equal(rejected.length, 0);
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0].evidence, []);
});

test('parseSpans：整体坏 JSON / spans 不是数组 -> 空结果不抛', () => {
  assert.equal(parseSpans('not json', { turns: TURNS }).spans.length, 0);
  assert.equal(parseSpans({ list: [] }, { turns: TURNS }).spans.length, 0);
  const bad = parseSpans('not json', { turns: TURNS });
  assert.equal(bad.rejected[0].reason, 'invalid_json');
});

// ---------------------------------------------------------------------------
// 主题解析
// ---------------------------------------------------------------------------

test('parseTopics：坏 slug 丢弃、span_ids 越界过滤、description 截断 300、已有主题保留旧 span', () => {
  const existingTopics = [{
    id: 'tp_old',
    scope: SCOPE,
    slug: 'old-topic',
    title: '旧主题',
    description: '旧描述',
    span_ids: ['sp_old'],
  }];
  const spans = [
    { id: 'sp_new', type: 'decision', text: '新决定', turns: [7] },
    { id: 'sp_new2', type: 'narrative', text: '新叙述', turns: [7] },
  ];

  const { topics, rejected } = parseTopics({
    topics: [
      { slug: 'Bad Slug', title: 'x', description: 'y', span_ids: ['sp_new'] },
      { slug: 'old-topic', title: '旧主题', description: '更新后的描述', span_ids: ['sp_new'] },
      {
        slug: 'brand-new',
        title: '',
        description: '描'.repeat(320),
        span_ids: ['sp_new2', 'sp_ghost'],
      },
      { slug: 'empty-topic', title: 'x', description: 'y', span_ids: ['sp_ghost'] },
    ],
  }, { spans, existingTopics });

  assert.deepEqual(rejected.map((item) => item.reason), ['bad_slug', 'no_span_ids']);
  assert.equal(topics.length, 2);

  const reused = topics.find((topic) => topic.slug === 'old-topic');
  assert.deepEqual(reused.span_ids, ['sp_new', 'sp_old'], '已有主题的旧 span 必须保留');
  assert.equal(reused.existing, true);

  const created = topics.find((topic) => topic.slug === 'brand-new');
  assert.deepEqual(created.span_ids, ['sp_new2'], '越界 span_id 被过滤');
  assert.equal(created.title, 'brand-new', '缺 title 时退回 slug');
  assert.equal(Array.from(created.description).length, 300, 'description 截断到 300 字');
  assert.equal(created.existing, false);
});

test('buildTopicMessages：包含已有主题 / 新增 span / 归组规则', () => {
  const messages = buildTopicMessages({
    spans: [{ id: 'sp_1', type: 'decision', text: '决定走独立配置文件', turns: [7] }],
    topics: [{
      slug: TOPIC_SLUG,
      title: 'TTS 情感与显存',
      description: '收了情感参数导致显存溢出的排查',
      span_ids: ['sp_0'],
    }],
  });

  assert.equal(messages.length, 2);
  const system = messages[0].content;
  assert.match(system, /优先复用已有主题/);
  assert.match(system, /description 不超过 300 字/);
  assert.match(system, /\[a-z0-9-\]/);
  assert.match(system, /同一个 span 可以出现在多个主题/);
  assert.match(system, /\{"topics":\[\]\}/);

  const user = messages[1].content;
  assert.match(user, new RegExp(TOPIC_SLUG));
  assert.match(user, /sp_1 \| decision \| 轮次 7/);
  assert.match(user, /决定走独立配置文件/);
});

// ---------------------------------------------------------------------------
// curateBatch
// ---------------------------------------------------------------------------

test('curateBatch：操作 span 入库、batch_id / evidence / session_ids / turns 都写对', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);
  const calls = [];
  const complete = fakeComplete([{ spans: [OPERATION_SPAN] }, { topics: [] }], calls);

  const result = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-1',
    turns: TURNS,
    complete,
    topicDir: dir,
  });

  assert.equal(calls.length, 2, 'span + topic 两次模型调用');
  assert.equal(result.inserted, 1);
  assert.equal(result.rejectedSpans, 0);
  assert.equal(result.batchId.length > 0, true);

  const row = db.prepare('SELECT * FROM spans').get();
  assert.equal(row.id, result.spanIds[0]);
  assert.equal(row.scope, SCOPE);
  assert.equal(row.type, 'operation');
  assert.equal(row.text, OPERATION_SPAN.text);
  assert.equal(row.batch_id, result.batchId);
  assert.equal(row.rationale_from, 'tool');
  assert.deepEqual(JSON.parse(row.turns), [7, 8]);
  assert.deepEqual(JSON.parse(row.session_ids), ['sess-1']);
  assert.deepEqual(JSON.parse(row.evidence), [
    { session_id: 'sess-1', seq: 8123, turn: 7 },
    { session_id: 'sess-1', seq: 8150, turn: 8 },
  ]);

  const curation = db.prepare('SELECT * FROM curations').get();
  assert.equal(curation.scope, SCOPE);
  assert.equal(curation.session_id, 'sess-1');
  assert.equal(curation.spans, 1);
  assert.equal(curation.topics, 0);
  assert.equal(curation.from_seq, 8121);
  assert.equal(curation.to_seq, 8151);
});

test('curateBatch：非法 span 全部丢弃时不调主题模型、不建 curation', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);
  const calls = [];
  const complete = fakeComplete([{ spans: [{ type: 'bogus', text: 'x', turns: [7] }] }], calls);

  const result = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-1',
    turns: TURNS,
    complete,
    topicDir: dir,
  });

  assert.equal(result.inserted, 0);
  assert.equal(result.rejectedSpans, 1);
  assert.equal(calls.length, 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM spans'), 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM curations'), 0);
});

test('curateBatch：dry-run 只解析并返回 span，不写 span / topic / curation', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);
  const calls = [];
  const complete = fakeComplete([{ spans: [OPERATION_SPAN] }], calls);

  const result = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-1',
    turns: TURNS,
    complete,
    topicDir: dir,
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.spans.length, 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.topics.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM spans'), 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM curations'), 0);
});

test('curateBatch：主题归组复用已有主题、新建主题、越界 span_id 被过滤、md 落盘', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);

  insertSpans(db, [{
    id: 'sp_oldtheme',
    scope: SCOPE,
    type: 'decision',
    text: '此前决定把 batch 降到 2',
    turns: [3],
    evidence: [],
    rationale_from: 'reasoning',
  }]);
  upsertTopic(db, {
    scope: SCOPE,
    slug: TOPIC_SLUG,
    title: 'TTS 情感与显存',
    description: '旧描述：情感参数导致显存溢出',
    span_ids: ['sp_oldtheme'],
  }, { dir });

  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    if (String(messages?.[0]?.content ?? '').includes('主题归组器')) {
      const [newId] = newSpanIdsFromPrompt(messages);
      return {
        topics: [
          {
            slug: TOPIC_SLUG,
            title: 'TTS 情感与显存',
            description: '收了情感参数导致显存溢出的排查，以及把参数拆到独立配置文件的决定',
            span_ids: [newId, 'sp_ghost'],
          },
          {
            slug: 'new-topic',
            title: '独立配置文件',
            description: '长'.repeat(350),
            span_ids: [newId],
          },
        ],
      };
    }
    return { spans: [OPERATION_SPAN] };
  };

  const result = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-1',
    turns: TURNS,
    complete,
    topicDir: dir,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.inserted, 1);
  assert.equal(result.topics.length, 2);
  assert.equal(result.topicIds.length, 2);
  assert.equal(result.rejectedTopics, 0);

  const reused = result.topics.find((topic) => topic.slug === TOPIC_SLUG);
  const created = result.topics.find((topic) => topic.slug === 'new-topic');
  assert.ok(reused);
  assert.ok(created);

  assert.ok(reused.span_ids.includes('sp_oldtheme'), '已有主题的旧 span 不能丢');
  assert.ok(reused.span_ids.includes(result.spanIds[0]), '新 span 必须进已有主题');
  assert.ok(!reused.span_ids.includes('sp_ghost'), '越界 span_id 必须过滤');

  assert.deepEqual(created.span_ids, [result.spanIds[0]]);
  assert.equal(Array.from(created.description).length, 300);

  const topics = listTopics(db, { scope: SCOPE });
  assert.equal(topics.length, 2);
  const reusedRow = topics.find((topic) => topic.slug === TOPIC_SLUG);
  assert.ok(reusedRow.span_ids.includes('sp_oldtheme'));

  assert.ok(typeof created.file === 'string' && existsSync(created.file), '主题 md 必须落盘');
  const markdown = readFileSync(created.file, 'utf8');
  assert.match(markdown, /^---/);
  assert.match(markdown, new RegExp(result.spanIds[0]));
  assert.match(markdown, /## spans/);
});

test('curateBatch：主题阶段模型失败不影响 span 入库', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);
  let call = 0;
  const complete = async () => {
    call += 1;
    if (call === 1) return { spans: [OPERATION_SPAN] };
    throw new Error('topic model down');
  };

  const result = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-1',
    turns: TURNS,
    complete,
    topicDir: dir,
  });

  assert.equal(result.inserted, 1);
  assert.equal(result.topics.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /topic model down/);
  assert.equal(count(db, 'SELECT count(*) AS n FROM spans'), 1);
});

test('curateBatch：embed.available=true 时写 span 向量和 topic 向量；available=false 跳过', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);

  const buildComplete = () => async (messages) => {
    if (String(messages?.[0]?.content ?? '').includes('主题归组器')) {
      const [newId] = newSpanIdsFromPrompt(messages);
      return {
        topics: [{
          slug: TOPIC_SLUG,
          title: 'TTS 情感与显存',
          description: '收了一组相关 span',
          span_ids: [newId],
        }],
      };
    }
    return { spans: [OPERATION_SPAN] };
  };

  const embedCalls = [];
  const embed = {
    available: true,
    model: 'test-embed',
    embed: async (texts) => {
      embedCalls.push(texts);
      return texts.map(() => Float32Array.from([1, 0, 0]));
    },
  };

  const result = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-1',
    turns: TURNS,
    complete: buildComplete(),
    topicDir: dir,
    embed,
  });

  assert.equal(result.embedded.spans, 1);
  assert.equal(result.embedded.topics, 1);
  assert.equal(embedCalls.length, 2, 'span 批次 + topic 批次各一次');
  assert.equal(count(db, 'SELECT count(*) AS n FROM span_vectors'), 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM topic_vectors'), 1);
  const vector = db.prepare('SELECT * FROM span_vectors').get();
  assert.equal(vector.model, 'test-embed');
  assert.equal(vector.dim, 3);

  // available=false：不生成、不报错
  const skipped = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-2',
    turns: TURNS,
    complete: buildComplete(),
    topicDir: dir,
    embed: { available: false, model: 'test-embed' },
  });
  assert.deepEqual(skipped.embedded, { spans: 0, topics: 0 });

  // 只传 config（无 embed 函数）：走 vectors.js 默认实现；backend=none 返回 null，不报错
  const configOnly = await curateBatch(db, {
    scope: SCOPE,
    sessionId: 'sess-3',
    turns: TURNS,
    complete: fakeComplete([{ spans: [OPERATION_SPAN] }, { topics: [] }]),
    topicDir: dir,
    embed: { backend: 'none', available: true, model: 'test-embed' },
  });
  assert.deepEqual(configOnly.embedded, { spans: 0, topics: 0 });
});

// ---------------------------------------------------------------------------
// curateSession / groupTurns
// ---------------------------------------------------------------------------

test('groupTurns：按 turn/start 的 data.turn 分组；只留四类事件；thinking/参数/输出按上限截断', () => {
  const reasoning = '思考'.repeat(500); // 1000 字
  const args = JSON.stringify({ path: 'x'.repeat(400) });
  const output = '输出'.repeat(500); // 1000 字
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 7 } },
    { type: 'system/message', seq: 2, data: { turn: 7, message: { content: [{ type: 'text', text: '系统提示' }] } } },
    { type: 'user/message', seq: 3, data: { turn: 7, content: [{ type: 'text', text: '用户问题' }] } },
    {
      type: 'assistant/message',
      seq: 4,
      data: { turn: 7, step: 1, message: { content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text: '正文' }] } },
    },
    { type: 'tool/call', seq: 5, data: { turn: 7, step: 2, name: 'read', arguments: args } },
    {
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 7,
        step: 2,
        message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: output }] }] },
      },
    },
    { type: 'turn/start', seq: 7, data: { turn: 8 } },
    { type: 'user/message', seq: 8, data: { turn: 8, content: [{ type: 'text', text: '第二问' }] } },
  ];

  const turns = groupTurns(events);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.turn), [7, 8]);

  const first = turns[0].events;
  assert.equal(first.length, 4, 'system/message 不能进结果');
  assert.deepEqual(first.map((event) => event.type), [
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
  ]);
  assert.equal(Array.from(first[1].thinking).length, 800, 'thinking 截断到 800 字');
  assert.equal(Array.from(first[2].args).length, 200, '工具参数截断到 200 字');
  assert.equal(Array.from(first[3].output).length, 500, '工具输出截断到 500 字');
  assert.equal(first[1].text, '正文');
});

test('groupTurns：没有 turn 信号时一条 user/message 开一轮', () => {
  const turns = groupTurns([
    { seq: 1, type: 'user/message', author: 'user', text: '第一问' },
    { seq: 2, type: 'assistant/message', author: 'assistant', text: '第一答' },
    { seq: 3, type: 'tool/call', author: 'tool', text: 'read {"p":"a"}' },
    { seq: 4, type: 'user/message', author: 'user', text: '第二问' },
  ]);
  assert.deepEqual(turns.map((turn) => turn.turn), [1, 2]);
  assert.equal(turns[0].events.length, 3);
  assert.equal(turns[1].events.length, 1);
  assert.equal(turns[0].events[2].tool, 'read');
});

test('curateSession：turnsPerBatch 分批、maxTurns 只取最近、events 可直接传入', async (t) => {
  const db = makeDb(t);
  const events = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    events.push({ type: 'turn/start', seq: turn * 100, data: { turn } });
    events.push({
      type: 'user/message',
      seq: turn * 100 + 1,
      data: { turn, content: [{ type: 'text', text: `第 ${turn} 轮问题` }] },
    });
    events.push({
      type: 'assistant/message',
      seq: turn * 100 + 2,
      data: { turn, message: { content: [{ type: 'text', text: `第 ${turn} 轮回答` }] } },
    });
  }

  const calls = [];
  const complete = fakeComplete([{ spans: [] }], calls);
  const stats = await curateSession(db, {
    sessionId: 'sess-batch',
    scope: SCOPE,
    turnsPerBatch: 2,
    maxTurns: 4,
    complete,
    events,
  });

  assert.equal(stats.source, 'provided');
  assert.equal(stats.turns, 4, 'maxTurns 只取最近 4 轮');
  assert.equal(stats.batches, 2);
  assert.equal(calls.length, 2);
  assert.equal(stats.inserted, 0);
  assert.equal(stats.failures, 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM spans'), 0);
});

test('curateSession：模型失败只记 failure，不中断后续批次', async (t) => {
  const db = makeDb(t);
  const events = [1, 2, 3].map((turn) => ({
    seq: turn * 10,
    type: 'user/message',
    author: 'user',
    text: `问题 ${turn}`,
  }));
  let call = 0;
  const complete = async () => {
    call += 1;
    if (call === 1) throw new Error('first batch down');
    return { spans: [] };
  };

  const stats = await curateSession(db, {
    sessionId: 'sess-fail',
    scope: SCOPE,
    turnsPerBatch: 1,
    complete,
    events,
  });

  assert.equal(stats.batches, 2);
  assert.equal(stats.failures, 1);
  assert.equal(stats.errors.length, 1);
  assert.match(stats.errors[0].message, /first batch down/);
});

test('curateSession：有 span 的批次会走两次模型并写库', async (t) => {
  const db = makeDb(t);
  const dir = makeTempDir(t);
  const events = [
    { type: 'turn/start', seq: 9000, data: { turn: 9 } },
    {
      type: 'user/message',
      seq: 9001,
      data: { turn: 9, content: [{ type: 'text', text: '把情感参数拆到配置文件。' }] },
    },
    {
      type: 'assistant/message',
      seq: 9002,
      data: { turn: 9, message: { content: [{ type: 'text', text: '好。' }] } },
    },
  ];
  const calls = [];
  const complete = fakeComplete([
    {
      spans: [{
        type: 'decision',
        text: '决定把情感参数拆到独立配置文件',
        turns: [9],
        evidence: [{ seq: 9001, turn: 9 }],
        rationale_from: 'user',
      }],
    },
    { topics: [] },
  ], calls);

  const stats = await curateSession(db, {
    sessionId: 'sess-9',
    scope: SCOPE,
    turnsPerBatch: 5,
    complete,
    events,
    topicDir: dir,
  });

  assert.equal(stats.batches, 1);
  assert.equal(stats.spans, 1);
  assert.equal(stats.inserted, 1);
  assert.equal(stats.topics, 0);
  assert.equal(calls.length, 2);
  assert.equal(count(db, 'SELECT count(*) AS n FROM spans'), 1);
});
