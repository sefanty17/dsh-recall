import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core/db.js';
import { insertSpans, searchSpans } from '../src/core/spans.js';
import { rerankTopicCandidates, retrieveSpans } from '../src/core/retrieve.js';

const SCOPE = 'D:\\personal_vibe\\demo';
const QUERY = 'TTS 情感参数';

/** 3 条都能被词法命中的 span；具体顺序以 searchSpans 的输出为准。 */
function makeFixture(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  const { ids } = insertSpans(db, [
    { scope: SCOPE, type: 'decision', text: 'TTS 情感参数走独立配置文件', turns: [7], evidence: [] },
    { scope: SCOPE, type: 'operation', text: 'TTS 情感参数导致显存溢出，降低 batch', turns: [8], evidence: [] },
    { scope: SCOPE, type: 'narrative', text: 'TTS 情感参数与降 batch 的记录', turns: [9], evidence: [] },
  ]);
  return { db, ids };
}

function scoreTable(scores) {
  return async ({ query, documents }) => {
    scoreTable.calls.push({ query, ids: documents.map((doc) => doc.id) });
    return documents.map((doc) => ({ id: doc.id, score: scores[doc.id] ?? 0 }));
  };
}
scoreTable.calls = [];

function baselineOf(db) {
  const baseline = searchSpans(db, { query: QUERY, scope: SCOPE, limit: 3 });
  assert.equal(baseline.length, 3, 'fixture 的三条 span 都应命中');
  return baseline;
}

// ---------------------------------------------------------------------------
// retrieveSpans
// ---------------------------------------------------------------------------

test('retrieveSpans：没有重排配置时与 searchSpans 结果一致', async (t) => {
  const { db } = makeFixture(t);
  const baseline = baselineOf(db);
  const result = await retrieveSpans(db, { query: QUERY, scope: SCOPE, limit: 3 });

  assert.deepEqual(result.map((item) => item.span.id), baseline.map((item) => item.span.id));
  assert.deepEqual(result.map((item) => item.score), baseline.map((item) => item.score));
  assert.ok(result.every((item) => !(item.reasons ?? []).some((line) => String(line).startsWith('rerank='))));

  // available=false 的配置同样不触发重排
  const unavailable = {
    backend: 'local',
    model: 'Xenova/bge-reranker-base',
    url: null,
    topN: 0,
    available: false,
  };
  const same = await retrieveSpans(db, { query: QUERY, scope: SCOPE, limit: 3, rerankCfg: unavailable });
  assert.deepEqual(same.map((item) => item.span.id), baseline.map((item) => item.span.id));
});

test('retrieveSpans：假 rerankFn 把原本第 3 名排到第 1', async (t) => {
  const { db } = makeFixture(t);
  const baseline = baselineOf(db);
  const [first, second, third] = baseline.map((item) => item.span.id);
  scoreTable.calls = [];
  const rerankFn = scoreTable({ [third]: 0.95, [second]: 0.5, [first]: 0.2 });

  const result = await retrieveSpans(db, { query: QUERY, scope: SCOPE, limit: 3, rerankFn });

  assert.equal(scoreTable.calls.length, 1, 'rerank 只调一次');
  assert.equal(scoreTable.calls[0].query, QUERY);
  assert.deepEqual(scoreTable.calls[0].ids, baseline.map((item) => item.span.id));
  assert.deepEqual(result.map((item) => item.span.id), [third, second, first]);
  assert.equal(result[0].score, 0.95);
  assert.equal(result[0].searchScore, baseline[2].score, '保留原分供排查');
  assert.ok(result[0].reasons.some((line) => line.startsWith('rerank=0.950')));
});

test('retrieveSpans：rerank 抛错 → 回退原顺序，不丢结果', async (t) => {
  const { db } = makeFixture(t);
  const baseline = baselineOf(db);
  let calls = 0;
  const rerankFn = async () => {
    calls += 1;
    throw new Error('rerank backend down');
  };

  const result = await retrieveSpans(db, { query: QUERY, scope: SCOPE, limit: 3, rerankFn });

  assert.equal(calls, 1);
  assert.deepEqual(result.map((item) => item.span.id), baseline.map((item) => item.span.id));
  assert.deepEqual(result.map((item) => item.score), baseline.map((item) => item.score));
  assert.ok(result.every((item) => !(item.reasons ?? []).some((line) => String(line).startsWith('rerank='))));
});

test('retrieveSpans：阈值过滤在重排之后生效', async (t) => {
  const { db } = makeFixture(t);
  const baseline = baselineOf(db);
  const [first, second, third] = baseline.map((item) => item.span.id);
  const rerankFn = scoreTable({ [third]: 0.95, [second]: 0.4, [first]: 0.2 });

  const result = await retrieveSpans(db, {
    query: QUERY,
    scope: SCOPE,
    limit: 3,
    threshold: 0.5,
    rerankFn,
  });

  // 原第 3 名被重排到第 1 且过阈值；原第 1、2 名被重排分压到 0.5 以下 → 过滤
  assert.deepEqual(result.map((item) => item.span.id), [third]);
  assert.equal(result[0].score, 0.95);
});

test('retrieveSpans：空 query → []，不调用 rerank', async (t) => {
  const { db } = makeFixture(t);
  let calls = 0;
  const result = await retrieveSpans(db, {
    query: '   ',
    rerankFn: async () => {
      calls += 1;
      return [];
    },
  });
  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// rerankTopicCandidates
// ---------------------------------------------------------------------------

test('rerankTopicCandidates：按重排分降序并附 rerankScore', async () => {
  const candidates = [
    { slug: 'a', title: 'TTS 情感', description: '情感参数与显存' },
    { slug: 'b', title: '前端构建', description: 'vite 配置' },
    { slug: 'c', title: 'TTS 参数', description: '独立配置文件' },
  ];
  const scores = { a: 0.2, b: 0.1, c: 0.9 };
  const rerankFn = async ({ documents }) => documents.map((doc) => ({
    id: doc.id,
    score: scores[doc.id] ?? 0,
  }));

  const result = await rerankTopicCandidates({ question: 'TTS 情感参数', candidates, rerankFn });

  assert.deepEqual(result.map((item) => item.slug), ['c', 'a', 'b']);
  assert.equal(result[0].rerankScore, 0.9);
  assert.equal(result[0].title, 'TTS 参数', '同结构字段保留');
  assert.equal(candidates[0].rerankScore, undefined, '不改入参数组');
});

test('rerankTopicCandidates：没有可用重排时保持原顺序', async () => {
  const candidates = [
    { slug: 'a', title: 'A', description: '' },
    { slug: 'b', title: 'B', description: '' },
  ];
  const emptyQuestion = await rerankTopicCandidates({ question: '', candidates });
  assert.deepEqual(emptyQuestion.map((item) => item.slug), ['a', 'b']);
  assert.equal(emptyQuestion[0].rerankScore, undefined);

  const unconfigured = await rerankTopicCandidates({
    question: 'q',
    candidates,
    cfg: { backend: 'none', available: false },
  });
  assert.deepEqual(unconfigured.map((item) => item.slug), ['a', 'b']);

  const failed = await rerankTopicCandidates({
    question: 'q',
    candidates,
    rerankFn: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(failed.map((item) => item.slug), ['a', 'b']);
  assert.equal(failed[0].rerankScore, undefined);
});
