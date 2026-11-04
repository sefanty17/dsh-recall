import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/core/db.js';
import { upsertFact } from '../src/core/facts.js';
import {
  filterQueries,
  generateQueries,
  loadActiveFacts,
  parseGeneratedQueries,
} from '../scripts/gen-queries.mjs';

const SCOPE = 'D:\\personal_vibe\\genq-demo';
const T0 = 1_700_000_000_000;

/** 5 条合成事实：4 条 typed + 1 条 note 型；evidence_seq 刻意从 11 开始。 */
const FACTS = [
  {
    key: 'pkg-manager',
    value: 'pnpm',
    kind: 'preference',
    quote: '以后统一用 pnpm',
    evidence_seq: 11,
  },
  {
    key: 'test-command',
    value: 'node --test',
    kind: 'decision',
    quote: '跑测试就用 node --test',
    evidence_seq: 12,
  },
  {
    key: 'port',
    value: '3000',
    kind: 'fact',
    quote: '开发端口固定在 3000',
    evidence_seq: 13,
  },
  {
    key: 'build-command',
    value: 'pnpm build',
    kind: 'decision',
    quote: '构建统一走 pnpm build',
    evidence_seq: 14,
  },
  {
    key: 'note',
    value: null,
    kind: 'fact',
    quote: null,
    note: '不要用 npm，lockfile 会跟 CI 冲突',
    evidence_seq: 15,
  },
];

const TWO_QUERIES = ['这个项目现在按什么来', '当时为什么这么定'];

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recall-genq-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedFacts(db, { skipEvidenceIndex = -1 } = {}) {
  FACTS.forEach((fact, index) => {
    upsertFact(db, {
      id: `fact-${index + 1}`,
      key: fact.key,
      value: fact.value,
      scope: SCOPE,
      kind: fact.kind,
      quote: fact.quote,
      note: fact.note ?? null,
      author: 'llm',
      verified: fact.quote ? 1 : 0,
      evidence_session: index === skipEvidenceIndex ? null : `sess-genq-${fact.evidence_seq}`,
      evidence_seq: index === skipEvidenceIndex ? null : fact.evidence_seq,
      created_at: T0 + index,
    });
  });
}

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeComplete(calls = []) {
  return async (messages) => {
    calls.push(messages);
    return { queries: TWO_QUERIES };
  };
}

// ---------------------------------------------------------------------------
// 正常生成 / JSONL 结构
// ---------------------------------------------------------------------------

test('generateQueries：每条事实生成问题，JSONL 字段与 expect 正确', async (t) => {
  const db = makeDb(t);
  seedFacts(db);
  const out = join(makeTempDir(t), 'queries-gen.jsonl');
  const calls = [];

  const stats = await generateQueries(db, {
    out,
    limit: 10,
    perFact: 2,
    complete: fakeComplete(calls),
  });

  assert.equal(stats.active, 5);
  assert.equal(stats.sampled, 5);
  assert.equal(stats.success, 5);
  assert.equal(stats.failed, 0);
  assert.equal(stats.empty, 0);
  assert.equal(stats.produced, 10);
  assert.equal(stats.written, 10);
  assert.equal(stats.duplicated, 0);
  assert.equal(calls.length, 5);

  // prompt：system 里有反照抄约束，user 里有事实原文（按 created_at 从新到旧取样）
  assert.match(calls[0][0].content, /不要照抄/);
  const pkgPrompt = calls
    .map((messages) => messages[1].content)
    .find((content) => content.includes('键：pkg-manager'));
  assert.ok(pkgPrompt, 'pkg-manager 的 prompt 应该存在');
  assert.match(pkgPrompt, /以后统一用 pnpm/);
  assert.match(pkgPrompt, /请生成 2 个问题/);
  assert.match(calls[0][1].content, /键：note/, 'created_at 最新的是 note 型事实');

  const rows = readJsonl(out);
  assert.equal(rows.length, 10);

  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['expect', 'fact_id', 'query', 'scope', 'source'],
      'JSONL 行字段固定',
    );
    assert.equal(typeof row.query, 'string');
    assert.ok(row.query.length > 0);
    assert.equal(row.scope, SCOPE);
    assert.equal(row.source, 'llm');
    assert.match(row.fact_id, /^fact-[1-5]$/);
    assert.equal(typeof row.expect.session_id, 'string');
    assert.equal(typeof row.expect.seq, 'number');
    // evidence 是成对的：sess-genq-<seq>
    assert.equal(row.expect.session_id, `sess-genq-${row.expect.seq}`);
  }

  const factIds = new Set(rows.map((row) => row.fact_id));
  assert.deepEqual([...factIds].sort(), ['fact-1', 'fact-2', 'fact-3', 'fact-4', 'fact-5']);

  const noteRows = rows.filter((row) => row.fact_id === 'fact-5');
  assert.equal(noteRows.length, 2);
  assert.equal(noteRows[0].expect.seq, 15);
});

test('generateQueries：重复运行按 fact_id+query 去重，只追加新问题', async (t) => {
  const db = makeDb(t);
  seedFacts(db);
  const out = join(makeTempDir(t), 'queries-gen.jsonl');
  const complete = fakeComplete();

  const first = await generateQueries(db, { out, limit: 10, perFact: 1, complete });
  assert.equal(first.written, 5);
  assert.equal(readJsonl(out).length, 5);

  // 第二次 perFact=2：每问一句旧的 + 一句新的，只应追加新的 5 行
  const second = await generateQueries(db, { out, limit: 10, perFact: 2, complete });
  assert.equal(second.written, 5);
  assert.equal(second.duplicated, 5);
  assert.equal(readJsonl(out).length, 10);

  // 第三次完全重复：一行都不加
  const third = await generateQueries(db, { out, limit: 10, perFact: 2, complete });
  assert.equal(third.written, 0);
  assert.equal(third.duplicated, 10);
  assert.equal(readJsonl(out).length, 10);
});

// ---------------------------------------------------------------------------
// 边界：缺 evidence / 空数组 / 失败重试
// ---------------------------------------------------------------------------

test('缺 evidence 的事实跳过，不调用模型、不写行', async (t) => {
  const db = makeDb(t);
  // 跳过第 5 条（note 型）的 evidence
  seedFacts(db, { skipEvidenceIndex: 4 });
  const out = join(makeTempDir(t), 'queries-gen.jsonl');
  const calls = [];

  const stats = await generateQueries(db, {
    out,
    limit: 10,
    perFact: 1,
    complete: fakeComplete(calls),
  });

  assert.equal(stats.active, 5);
  assert.equal(stats.skippedNoEvidence, 1);
  assert.equal(stats.sampled, 4);
  assert.equal(calls.length, 4);
  assert.equal(stats.written, 4);

  const rows = readJsonl(out);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.fact_id !== 'fact-5'));

  // loadActiveFacts 单独也返回同样的跳过统计
  const loaded = loadActiveFacts(db, { limit: 10 });
  assert.equal(loaded.facts.length, 4);
  assert.equal(loaded.skippedNoEvidence, 1);
});

test('模型返回空数组：不产生行，也不算失败', async (t) => {
  const db = makeDb(t);
  seedFacts(db);
  const out = join(makeTempDir(t), 'queries-gen.jsonl');
  let calls = 0;
  const complete = async () => {
    calls += 1;
    return { queries: [] };
  };

  const stats = await generateQueries(db, { out, limit: 10, perFact: 2, complete });

  assert.equal(calls, 5);
  assert.equal(stats.success, 5);
  assert.equal(stats.failed, 0);
  assert.equal(stats.empty, 5);
  assert.equal(stats.produced, 0);
  assert.equal(stats.written, 0);
  assert.equal(existsSync(out), false, '没有行就不应该创建输出文件');
});

test('模型调用失败重试 1 次；两次都失败则跳过并 redact 密钥', async (t) => {
  const db = makeDb(t);
  seedFacts(db);
  const out = join(makeTempDir(t), 'queries-gen.jsonl');

  // 第一次抛错、第二次成功
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary boom');
    return { queries: [TWO_QUERIES[0]] };
  };
  const retried = await generateQueries(db, {
    out,
    limit: 1,
    perFact: 1,
    complete: flaky,
  });
  assert.equal(calls, 2);
  assert.equal(retried.success, 1);
  assert.equal(retried.failed, 0);
  assert.equal(retried.written, 1);

  // 两次都失败：跳过该事实，日志里的 sk- 串被替换
  const out2 = join(makeTempDir(t), 'queries-gen.jsonl');
  const lines = [];
  let failedCalls = 0;
  const broken = async () => {
    failedCalls += 1;
    throw new Error('auth failed for sk-livesecret123');
  };
  const stats = await generateQueries(db, {
    out: out2,
    limit: 1,
    perFact: 1,
    complete: broken,
    log: (line) => lines.push(line),
  });

  assert.equal(failedCalls, 2, '失败重试 1 次 = 总共 2 次调用');
  assert.equal(stats.success, 0);
  assert.equal(stats.failed, 1);
  assert.equal(stats.written, 0);
  assert.equal(existsSync(out2), false);
  assert.ok(lines.some((line) => line.includes('<redacted>')));
  assert.ok(lines.every((line) => !line.includes('sk-livesecret123')));
});

// ---------------------------------------------------------------------------
// 解析 / 过滤（不联网）
// ---------------------------------------------------------------------------

test('parseGeneratedQueries 剥 ```json 围栏；filterQueries 去元话术和照抄', () => {
  const parsed = parseGeneratedQueries(
    '```json\n{"queries":["这个项目现在按什么来","根据记忆，包管理器是 pnpm"]}\n```',
  );
  assert.deepEqual(parsed, ['这个项目现在按什么来', '根据记忆，包管理器是 pnpm']);

  const fact = { quote: '以后统一用 pnpm' };
  const filtered = filterQueries(
    [
      '根据记忆，包管理器是 pnpm', // 元话术
      '这个项目现在按什么来', // 正常
      '以后统一用 pnpm 吗', // 照抄 quote
      'which package manager', // 纯英文
      '短', // 太短
      '这个项目现在按什么来', // 重复
    ],
    fact,
    5,
  );
  assert.deepEqual(filtered, ['这个项目现在按什么来']);

  assert.throws(() => parseGeneratedQueries({ nope: true }), /queries 数组/);
});
