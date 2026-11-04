import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/core/db.js';
import { listFacts } from '../src/core/facts.js';
import {
  buildExtractionMessages,
  extractAll,
  extractSessionFacts,
  parseFacts,
  selectUserMessages,
} from '../src/core/extract.js';
import { resolveLlmConfig } from '../src/core/llm.js';

const SCOPE = 'D:\\personal_vibe\\demo';

const MESSAGES = [
  { seq: 1, time: 1000, text: '以后统一用 pnpm，测试用 vitest。' },
  { seq: 2, time: 2000, text: '不要用 npm，lockfile 会跟 CI 冲突。' },
];

const HEADER = {
  id: 'sess-llm-1',
  cwd: SCOPE,
  delegationDepth: 0,
  createdAt: 900,
};

const RESPONSE = {
  facts: [
    {
      key: 'pkg-manager',
      value: 'pnpm',
      kind: 'preference',
      quote: '统一用 pnpm',
      seq: 1,
      note: '用户定的',
    },
    {
      key: 'never-use',
      value: 'npm',
      kind: 'constraint',
      quote: '不要用 npm',
      seq: 2,
      note: null,
    },
  ],
};

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recall-extract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeComplete(payload, calls = []) {
  return async (messages) => {
    calls.push(messages);
    return typeof payload === 'function' ? payload(messages) : payload;
  };
}

function count(db, sql, params = []) {
  return Number(db.prepare(sql).get(...params).n);
}

function writeSession(root, folder, header, events) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const lines = [header, ...events].map((record) => JSON.stringify(record));
  writeFileSync(join(dir, 'session.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return join(dir, 'session.jsonl');
}

function userEvent(seq, time, text) {
  return {
    type: 'user/message',
    seq,
    time,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  };
}

// ---------------------------------------------------------------------------
// 正常抽取 / 引文校验
// ---------------------------------------------------------------------------

test('extractSessionFacts：正常抽取写入 llm 事实，引文 span 准确', async (t) => {
  const db = makeDb(t);
  const calls = [];

  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(RESPONSE, calls) },
  );

  assert.deepEqual(result, { inserted: 2, updated: 0, rejected: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0].content, /项目记忆抽取器/);
  assert.match(calls[0][1].content, /\[1\]/);

  const facts = listFacts(db, { scope: SCOPE });
  assert.deepEqual(facts.map((fact) => fact.key).sort(), ['never-use', 'pkg-manager']);

  const pkg = facts.find((fact) => fact.key === 'pkg-manager');
  assert.equal(pkg.value, 'pnpm');
  assert.equal(pkg.kind, 'preference');
  assert.equal(pkg.author, 'llm');
  assert.equal(pkg.verified, 1);
  assert.equal(pkg.since, 1000);
  assert.equal(pkg.status, 'active');
  assert.equal(pkg.quote, '统一用 pnpm');
  assert.equal(pkg.note, '用户定的');
  assert.equal(pkg.evidence_session, HEADER.id);
  assert.equal(pkg.evidence_seq, 1);
  assert.equal(pkg.span_start, MESSAGES[0].text.indexOf('统一用 pnpm'));
  assert.equal(pkg.span_end, pkg.span_start + '统一用 pnpm'.length - 1);

  const never = facts.find((fact) => fact.key === 'never-use');
  assert.equal(never.value, 'npm');
  assert.equal(never.kind, 'constraint');
  assert.equal(never.verified, 1);

  const session = db.prepare('SELECT llm_extracted_at FROM sessions WHERE id = ?').get(HEADER.id);
  assert.equal(typeof session.llm_extracted_at, 'number');
});

test('parseFacts：quote 不是原文子串 / seq 不存在 -> rejected，不写库', async (t) => {
  const db = makeDb(t);
  const payload = {
    facts: [
      { key: 'pkg-manager', value: 'pnpm', kind: 'preference', quote: '统一用 pnpm', seq: 1 },
      // 改写了引文（「使用」不是原文），必须丢弃
      { key: 'pkg-manager', value: 'npm', kind: 'preference', quote: '以后统一使用 pnpm', seq: 1 },
      { key: 'port', value: '3000', kind: 'fact', quote: '3000', seq: 99 },
    ],
  };

  const parsed = parseFacts(payload, { header: HEADER, messages: MESSAGES });
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.rejected.length, 2);
  assert.deepEqual(
    parsed.rejected.map((item) => item.reason).sort(),
    ['quote_not_found', 'seq_not_found'],
  );

  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(payload) },
  );
  assert.equal(result.inserted, 1);
  assert.equal(result.rejected, 2);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM facts').get().n, 1);
});

test('parseFacts：非法 kind/key/value 归一化而不是整条丢弃', async (t) => {
  const db = makeDb(t);
  const payload = {
    facts: [
      {
        key: 'Bad Key!',
        value: 'has space',
        kind: 'made-up',
        quote: 'lockfile 会跟 CI 冲突',
        seq: 2,
        note: '  说明  ',
      },
      {
        key: 'port',
        value: 3000,
        kind: 'constraint',
        quote: '不要用 npm',
        seq: 2,
      },
    ],
  };

  const { facts, rejected } = parseFacts(payload, { header: HEADER, messages: MESSAGES });
  assert.equal(rejected.length, 0);
  assert.equal(facts[0].key, 'note');
  assert.equal(facts[0].kind, 'fact');
  assert.equal(facts[0].value, null);
  assert.equal(facts[0].note, '说明');
  assert.equal(facts[1].key, 'port');
  assert.equal(facts[1].kind, 'constraint');
  assert.equal(facts[1].value, '3000');

  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(payload) },
  );
  assert.equal(result.inserted, 2);

  const rows = listFacts(db, { scope: SCOPE });
  const note = rows.find((fact) => fact.key === 'note');
  assert.equal(note.value, null);
  assert.equal(note.kind, 'fact');
  assert.equal(rows.find((fact) => fact.key === 'port').value, '3000');
});

test('命令类 key 的 value 允许单个空格；连续空格/超长/普通 key 仍为 null', () => {
  const messages = [{
    seq: 1,
    time: 1000,
    text: '测试用 cargo test，构建用 go build ./...，部署用 docker compose up -d。',
  }];

  const accepted = parseFacts({
    facts: [
      { key: 'test-command', value: 'cargo test', quote: 'cargo test', seq: 1 },
      { key: 'build-command', value: 'go build ./...', quote: 'go build ./...', seq: 1 },
      { key: 'deploy', value: 'docker compose up -d', quote: 'docker compose up -d', seq: 1 },
    ],
  }, { header: HEADER, messages });
  assert.equal(accepted.rejected.length, 0);
  assert.deepEqual(
    accepted.facts.map((fact) => fact.value),
    ['cargo test', 'go build ./...', 'docker compose up -d'],
  );

  const rejectedValues = parseFacts({
    facts: [
      // 连续两个空格
      { key: 'test-command', value: 'cargo  test', quote: 'cargo test', seq: 1 },
      // 超过 60 字符
      { key: 'build-command', value: 'x'.repeat(61), quote: 'go build ./...', seq: 1 },
      // 只有命令类 key 放宽；pkg-manager 仍是标识符
      { key: 'pkg-manager', value: 'npm install', quote: 'cargo test', seq: 1 },
    ],
  }, { header: HEADER, messages });
  assert.equal(rejectedValues.rejected.length, 0);
  assert.deepEqual(rejectedValues.facts.map((fact) => fact.value), [null, null, null]);
  assert.deepEqual(
    rejectedValues.facts.map((fact) => fact.key),
    ['test-command', 'build-command', 'pkg-manager'],
  );
});

test('自造 key：合法 slug + 中文短语；非法 key/超长值回退 note 且不丢弃', async (t) => {
  const db = makeDb(t);
  const messages = [
    { seq: 1, time: 1000, text: '配色改成暖色调为主。' },
    { seq: 2, time: 1100, text: '文档只保留最新方案。' },
    { seq: 3, time: 1200, text: '这是一句很长的话。' },
    { seq: 4, time: 1300, text: '坏 key 测试。' },
  ];
  const payload = {
    facts: [
      { key: 'ui-style', value: '暖色调为主', kind: 'preference', quote: '暖色调为主', seq: 1 },
      { key: 'doc-policy', value: '只保留最新方案', kind: 'decision', quote: '只保留最新方案', seq: 2 },
      // 自造 key 的值超长 -> 整条回退 note/null，而不是丢弃
      { key: 'ui-style', value: '暖'.repeat(25), kind: 'preference', quote: '这是一句很长的话', seq: 3 },
      // key 不是合法 slug -> note/null
      { key: 'Bad Key', value: '坏 key 值', kind: 'fact', quote: '坏 key 测试', seq: 4 },
    ],
  };

  const parsed = parseFacts(payload, { header: HEADER, messages });
  assert.equal(parsed.rejected.length, 0);
  assert.deepEqual(
    parsed.facts.map((fact) => [fact.key, fact.value]),
    [
      ['ui-style', '暖色调为主'],
      ['doc-policy', '只保留最新方案'],
      ['note', null],
      ['note', null],
    ],
  );

  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages },
    { complete: fakeComplete(payload) },
  );
  assert.equal(result.inserted, 4);
  assert.equal(result.rejected, 0);
  assert.equal(listFacts(db, { scope: SCOPE }).length, 4);
  assert.equal(listFacts(db, { scope: SCOPE, key: 'ui-style' })[0].value, '暖色调为主');
});

test('自造 key 的 value：超长/换行/标点结尾/非法 slug 都回退 note', () => {
  const messages = [
    { seq: 1, time: 1, text: '第一句话。' },
    { seq: 2, time: 2, text: '第二行内容' },
    { seq: 3, time: 3, text: '第三句结尾' },
    { seq: 4, time: 4, text: '第四句测试' },
  ];
  const { facts, rejected } = parseFacts({
    facts: [
      { key: 'ui-style', value: '暖'.repeat(25), kind: 'preference', quote: '第一句话', seq: 1 },
      { key: 'ui-style', value: '第一行\n第二行', kind: 'preference', quote: '第二行内容', seq: 2 },
      { key: 'ui-style', value: '句号结尾。', kind: 'preference', quote: '第三句结尾', seq: 3 },
      // 25 个字符，超出 slug 的 24 上限
      { key: 'a'.repeat(25), value: '短值', kind: 'fact', quote: '第四句测试', seq: 4 },
    ],
  }, { header: HEADER, messages });

  assert.equal(rejected.length, 0, '校验失败只回退，不丢弃');
  assert.deepEqual(
    facts.map((fact) => [fact.key, fact.value]),
    [['note', null], ['note', null], ['note', null], ['note', null]],
  );
});

test('两条 note（不同 quote）都保留为 active', async (t) => {
  const db = makeDb(t);
  const payload = {
    facts: [
      { key: 'note', value: null, kind: 'fact', quote: '统一用 pnpm', seq: 1 },
      { key: 'note', value: null, kind: 'fact', quote: '不要用 npm', seq: 2 },
    ],
  };

  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(payload) },
  );
  assert.equal(result.inserted, 2);

  const notes = listFacts(db, { scope: SCOPE }).filter((fact) => fact.key === 'note');
  assert.equal(notes.length, 2, '两条 note 应按 quote 各自保留');
  assert.deepEqual(notes.map((fact) => fact.quote).sort(), ['不要用 npm', '统一用 pnpm']);
});

// ---------------------------------------------------------------------------
// 输入选择
// ---------------------------------------------------------------------------

test('只把 source.kind=user 的消息送给模型；plugin / assistant 一律跳过', async (t) => {
  const db = makeDb(t);
  const events = [
    userEvent(4, 1000, '以后统一用 pnpm。'),
    {
      type: 'user/message',
      seq: 5,
      time: 1100,
      data: {
        source: { kind: 'plugin' },
        content: [{ type: 'text', text: 'plugin 注入：不要用 yarn。' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 6,
      time: 1200,
      data: { message: { content: [{ type: 'text', text: '收到。' }] } },
    },
  ];

  assert.equal(selectUserMessages(events).length, 1);
  assert.equal(selectUserMessages(events)[0].seq, 4);

  let captured = null;
  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages: events },
    {
      complete: async (messages) => {
        captured = messages;
        return { facts: [] };
      },
    },
  );

  assert.equal(result.rejected, 0);
  assert.equal(captured.length, 2, 'system + user');
  assert.match(captured[0].content, /quote 必须是某条消息里逐字出现的片段/);
  assert.match(captured[1].content, /\[4\]/);
  assert.match(captured[1].content, /以后统一用 pnpm/);
  assert.doesNotMatch(captured[1].content, /plugin 注入/);
  assert.match(captured[1].content, /D:\\personal_vibe\\demo/);

  // 模型返回 0 条也算处理完成：写幂等标记，第二次跳过
  const second = await extractSessionFacts(
    db,
    { header: HEADER, messages: events },
    { complete: fakeComplete({ facts: [] }) },
  );
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 0);
});

test('子代理会话（delegationDepth>0 或 origin=subagent）不调用模型', async (t) => {
  const db = makeDb(t);
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return RESPONSE;
  };

  const depth = await extractSessionFacts(
    db,
    { header: { ...HEADER, id: 'sub-1', delegationDepth: 1 }, messages: MESSAGES },
    { complete },
  );
  assert.deepEqual(depth, { inserted: 0, updated: 0, rejected: 0 });

  const origin = await extractSessionFacts(
    db,
    { header: { ...HEADER, id: 'sub-2', origin: 'subagent' }, messages: MESSAGES },
    { complete },
  );
  assert.deepEqual(origin, { inserted: 0, updated: 0, rejected: 0 });

  assert.equal(calls, 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 0);
});

// ---------------------------------------------------------------------------
// 幂等 / dry-run
// ---------------------------------------------------------------------------

test('同一会话跑两次：第二次不 force 直接跳过；force 才刷新', async (t) => {
  const db = makeDb(t);
  const calls = [];

  const first = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(RESPONSE, calls) },
  );
  assert.equal(first.inserted, 2);

  const second = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(RESPONSE, calls) },
  );
  assert.deepEqual(second, { inserted: 0, updated: 0, rejected: 0 });
  assert.equal(calls.length, 1, '第二次不应调用模型');
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 2);

  const forced = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    { complete: fakeComplete(RESPONSE, calls), force: true },
  );
  assert.deepEqual(forced, { inserted: 0, updated: 2, rejected: 0 });
  assert.equal(calls.length, 2);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 2, 'force 只刷新，不重复插入');
});

test('dry-run：只回传事实，不写 facts / sessions 标记', async (t) => {
  const db = makeDb(t);
  const written = [];

  const result = await extractSessionFacts(
    db,
    { header: HEADER, messages: MESSAGES },
    {
      complete: fakeComplete(RESPONSE),
      dryRun: true,
      onFact: (fact, phase) => written.push({ fact, phase }),
    },
  );

  assert.deepEqual(result, { inserted: 2, updated: 0, rejected: 0 });
  assert.equal(written.length, 2);
  assert.equal(written[0].phase, 'dry-run');
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 0);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM sessions WHERE id = ?').get(HEADER.id).n,
    0,
    'dry-run 连 session 行都不应该建',
  );
});

// ---------------------------------------------------------------------------
// 配置解析（不联网）
// ---------------------------------------------------------------------------

test('resolveLlmConfig：没有任何凭据时 available=false 且不抛异常', () => {
  const missing = join(tmpdir(), 'dsh-recall-no-such-credentials.yaml');
  const config = resolveLlmConfig({ DSH_RECALL_CREDENTIALS: missing });

  assert.equal(config.available, false);
  assert.equal(config.apiKey, null);
  assert.equal(config.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.model, 'deepseek-chat');
});

test('resolveLlmConfig：credentials.yaml 的字面量 ref', (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'credentials.yaml');
  writeFileSync(
    file,
    [
      'version: 1',
      'refs:',
      '  DEEPSEEK_API_KEY: "test-key-from-file"',
      '  OTHER_KEY: ignore-me',
      'records:',
      '  kind: test',
      '  payload: {}',
      '',
    ].join('\n'),
    'utf8',
  );

  const config = resolveLlmConfig({ DSH_RECALL_CREDENTIALS: file });
  assert.equal(config.available, true);
  assert.equal(config.apiKey, 'test-key-from-file');
});

test('resolveLlmConfig：env:NAME 形式的 ref，且环境变量优先级更高', (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'credentials.yaml');
  writeFileSync(file, 'refs:\n  DEEPSEEK_API_KEY: env:MY_TEST_KEY\n', 'utf8');

  const fromEnvRef = resolveLlmConfig({
    DSH_RECALL_CREDENTIALS: file,
    MY_TEST_KEY: 'test-key-from-env-ref',
  });
  assert.equal(fromEnvRef.available, true);
  assert.equal(fromEnvRef.apiKey, 'test-key-from-env-ref');

  const missingEnv = resolveLlmConfig({ DSH_RECALL_CREDENTIALS: file });
  assert.equal(missingEnv.available, false);

  const direct = resolveLlmConfig({
    DSH_RECALL_CREDENTIALS: file,
    MY_TEST_KEY: 'test-key-from-env-ref',
    DEEPSEEK_API_KEY: 'test-key-direct-env',
  });
  assert.equal(direct.apiKey, 'test-key-direct-env', '环境变量优先于配置文件');
});

// ---------------------------------------------------------------------------
// 批量
// ---------------------------------------------------------------------------

test('parseFacts 接受带 ```json 围栏的字符串', () => {
  const raw = `\`\`\`json\n${JSON.stringify(RESPONSE)}\n\`\`\``;
  const { facts, rejected } = parseFacts(raw, { header: HEADER, messages: MESSAGES });
  assert.equal(rejected.length, 0);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].quote, '统一用 pnpm');
});

test('extractAll：按目录扫描、跳过子代理/别的项目，force 可重跑', async (t) => {
  const root = makeTempDir(t);
  const rootHeader = {
    type: 'session',
    version: 0,
    id: 'root-a',
    cwd: SCOPE,
    createdAt: 1000,
    delegationDepth: 0,
  };
  writeSession(root, 'root-a', rootHeader, [userEvent(1, 1000, '以后统一用 pnpm。')]);
  writeSession(
    root,
    'sub-b',
    { ...rootHeader, id: 'sub-b', delegationDepth: 1, origin: 'subagent' },
    [userEvent(1, 1100, '以后统一用 pnpm。')],
  );
  writeSession(
    root,
    'project-b',
    { ...rootHeader, id: 'root-b', cwd: 'D:\\personal_vibe\\other' },
    [userEvent(1, 1200, '以后统一用 pnpm。')],
  );

  const payload = {
    facts: [
      {
        key: 'pkg-manager',
        value: 'pnpm',
        kind: 'preference',
        quote: '统一用 pnpm',
        seq: 1,
        note: null,
      },
    ],
  };
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return payload;
  };

  const db = makeDb(t);
  const first = await extractAll(db, root, { complete, maxSessions: 10, project: SCOPE });
  assert.equal(first.files, 3);
  assert.equal(first.sessions, 1);
  assert.equal(first.skipped, 2);
  assert.equal(first.failed, 0);
  assert.equal(first.inserted, 1);
  assert.equal(calls, 1);
  assert.equal(listFacts(db, { scope: SCOPE }).length, 1);

  const second = await extractAll(db, root, { complete, maxSessions: 10, project: SCOPE });
  assert.equal(second.sessions, 0);
  assert.equal(second.skipped, 3);
  assert.equal(calls, 1, '已处理的会话不应再次调用模型');

  const forced = await extractAll(db, root, {
    complete,
    maxSessions: 10,
    project: SCOPE,
    force: true,
  });
  assert.equal(forced.sessions, 1);
  assert.equal(calls, 2);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 1);

  const otherDb = makeDb(t);
  const other = await extractAll(otherDb, root, {
    complete,
    project: 'D:\\personal_vibe\\other',
  });
  assert.equal(other.sessions, 1);
  assert.equal(listFacts(otherDb, { scope: 'D:\\personal_vibe\\other' }).length, 1);
});

test('buildExtractionMessages：会话时间 + 编号用户消息，roles 固定', () => {
  const prompt = buildExtractionMessages({
    header: { ...HEADER, createdAt: 1700000000000 },
    messages: MESSAGES,
  });
  assert.equal(prompt.length, 2);
  assert.equal(prompt[0].role, 'system');
  assert.equal(prompt[1].role, 'user');
  assert.match(prompt[0].content, /decision\|preference\|constraint\|failure\|fact/);
  assert.match(prompt[0].content, /pkg-manager/);
  assert.match(prompt[0].content, /长期约束后续工作/);
  assert.match(prompt[0].content, /临时要求，用 note/);
  assert.match(prompt[0].content, /自造短英文 slug/);
  assert.match(prompt[0].content, /ui-style/);
  assert.match(prompt[0].content, /≤24 字/);
  assert.match(prompt[1].content, /2023-11-14/);
  assert.match(prompt[1].content, /\[1\]/);
  assert.match(prompt[1].content, /\[2\]/);
  assert.match(prompt[1].content, /不要用 npm/);
});
