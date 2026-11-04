import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core/db.js';
import {
  insertSpans,
  listSpans,
  searchSpans,
  spanById,
} from '../src/core/spans.js';
import { saveSpanVectors } from '../src/core/vectors.js';

const SCOPE = 'D:\\personal_vibe\\dsh-recall';
const OTHER_SCOPE = 'D:\\personal_vibe\\other';
const S1 = '019c6e8f-aaaa-7bbb-8ccc-000000000001';
const S2 = '019c6e8f-bbbb-7bbb-8ccc-000000000002';

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function span(overrides = {}) {
  return {
    scope: SCOPE,
    type: 'decision',
    text: '决定 TTS 情感参数走独立配置文件',
    turns: [7],
    evidence: [{ session_id: S1, seq: 8121, turn: 7 }],
    rationale_from: 'reasoning',
    ...overrides,
  };
}

function seed(db) {
  return insertSpans(db, [
    span(),
    span({
      type: 'operation',
      text: '读 agent_search 仓库 12 个文件，定位搜索实现',
      turns: [8, 9],
      evidence: [
        { session_id: S1, seq: 8150, turn: 8 },
        { session_id: S2, seq: 8200, turn: 9 },
      ],
      rationale_from: 'tool',
    }),
    span({
      type: 'narrative',
      text: '用户描述自己喜欢的水果和香水类型及原因',
      turns: [10],
      evidence: [{ session_id: S2, seq: 8300, turn: 10 }],
      rationale_from: 'user',
    }),
  ]).ids;
}

// ---------------------------------------------------------------------------
// 写入 / 查询
// ---------------------------------------------------------------------------

test('insertSpans：生成 sp_ 开头的 12 位 id，JSON 字段可往返', (t) => {
  const db = makeDb(t);
  const { inserted, ids } = insertSpans(db, [
    span(),
    span({
      type: 'operation',
      text: '读 agent_search 仓库 12 个文件，定位搜索实现',
      turns: [8, 9],
      evidence: [
        { session_id: S1, seq: 8150, turn: 8 },
        { session_id: S2, seq: 8200, turn: 9 },
      ],
      rationale_from: 'tool',
    }),
  ]);

  assert.equal(inserted, 2);
  assert.equal(ids.length, 2);
  for (const id of ids) assert.match(id, /^sp_[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, 2, 'id 不能重复');

  const first = spanById(db, ids[0]);
  assert.equal(first.id, ids[0]);
  assert.equal(first.scope, SCOPE);
  assert.equal(first.type, 'decision');
  assert.equal(first.text, '决定 TTS 情感参数走独立配置文件');
  assert.deepEqual(first.turns, [7]);
  assert.deepEqual(first.evidence, [{ session_id: S1, seq: 8121, turn: 7 }]);
  assert.deepEqual(first.session_ids, [S1], '缺省 session_ids 从 evidence 推导');
  assert.equal(first.rationale_from, 'reasoning');
  assert.equal(first.batch_id, null);
  assert.equal(first.updated_at, null);
  assert.equal(typeof first.created_at, 'number');

  const second = spanById(db, ids[1]);
  assert.deepEqual(second.turns, [8, 9]);
  assert.deepEqual(second.session_ids, [S1, S2]);
  assert.equal(second.rationale_from, 'tool');

  // FTS 里存的是按字切开的文本
  const fts = db.prepare('SELECT search_text FROM span_fts WHERE span_id = ?').get(ids[0]);
  assert.match(fts.search_text, /决 定 TTS 情 感 参 数/);

  assert.equal(spanById(db, 'sp_missing'), null);
  assert.equal(spanById(db, ''), null);
});

test('insertSpans：调用方给了 id 就沿用，空数组返回零', (t) => {
  const db = makeDb(t);
  const { ids } = insertSpans(db, [span({ id: 'sp_custom000001' })]);
  assert.deepEqual(ids, ['sp_custom000001']);
  assert.equal(spanById(db, 'sp_custom000001').text, '决定 TTS 情感参数走独立配置文件');

  assert.deepEqual(insertSpans(db, []), { inserted: 0, ids: [] });
});

test('insertSpans：type / text 非法时抛明确错误', (t) => {
  const db = makeDb(t);
  assert.throws(() => insertSpans(db, [span({ type: 'bogus' })]), /type 必须是/);
  assert.throws(() => insertSpans(db, [span({ text: '   ' })]), /text 不能为空/);
  assert.throws(() => insertSpans(db, [null]), /不是对象/);
});

test('listSpans：scope / ids / limit 过滤，按写入顺序返回', (t) => {
  const db = makeDb(t);
  const ids = seed(db);
  insertSpans(db, [span({ scope: OTHER_SCOPE, text: '另一个项目里的决定' })]);

  const scoped = listSpans(db, { scope: SCOPE });
  assert.equal(scoped.length, 3);
  assert.deepEqual(scoped.map((item) => item.id), ids);

  assert.equal(listSpans(db, { scope: OTHER_SCOPE }).length, 1);
  assert.equal(listSpans(db).length, 4, '不传 scope 返回全部');

  assert.deepEqual(listSpans(db, { ids: [ids[2], ids[0]] }).map((item) => item.id).sort(), [ids[0], ids[2]].sort());
  assert.deepEqual(listSpans(db, { ids: [] }), []);

  assert.equal(listSpans(db, { scope: SCOPE, limit: 2 }).length, 2);
});

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

test('searchSpans：中文整句 phrase 命中，返回 [{span, score, reasons}]', (t) => {
  const db = makeDb(t);
  const ids = seed(db);

  const results = searchSpans(db, { query: '情感参数', scope: SCOPE });
  assert.ok(results.length >= 1);
  assert.equal(results[0].span.id, ids[0]);
  assert.equal(results[0].span.text, '决定 TTS 情感参数走独立配置文件');
  assert.ok(results[0].score > 0 && results[0].score <= 1);
  assert.ok(Array.isArray(results[0].reasons));
  assert.ok(results[0].reasons.some((reason) => reason.startsWith('match=phrase')));
  assert.ok(results[0].reasons.some((reason) => reason.startsWith('bm25=')));

  assert.deepEqual(searchSpans(db, { query: '   ' }), []);
  assert.deepEqual(searchSpans(db, { query: '完全不存在的东西' }), []);
});

test('searchSpans：自然语言问句走中文 bigram OR 回退', (t) => {
  const db = makeDb(t);
  const ids = seed(db);

  const results = searchSpans(db, {
    query: '为什么情感参数会导致显存溢出',
    scope: SCOPE,
  });
  assert.ok(results.length >= 1);
  assert.equal(results[0].span.id, ids[0]);
  const reasons = results[0].reasons.join(' ');
  assert.match(reasons, /match=bigram/);
  assert.match(reasons, /bigram:\d+\/\d+/);
  assert.match(reasons, /coverage=/);
});

test('searchSpans：拉丁词 + 中文 bigram 混合回退', (t) => {
  const db = makeDb(t);
  const ids = seed(db);

  const results = searchSpans(db, { query: 'agent_search 搜索实现', scope: SCOPE });
  assert.ok(results.length >= 1);
  assert.equal(results[0].span.id, ids[1]);
  assert.match(results[0].reasons.join(' '), /match=bigram/);
});

test('searchSpans：scope 过滤、limit、threshold', (t) => {
  const db = makeDb(t);
  const ids = seed(db);
  insertSpans(db, [
    span({ scope: OTHER_SCOPE, text: '别的项目也在讨论决定 TTS 情感参数', turns: [1] }),
  ]);

  const scoped = searchSpans(db, { query: '情感参数', scope: SCOPE });
  assert.ok(scoped.every((item) => item.span.scope === SCOPE));

  const all = searchSpans(db, { query: '情感参数' });
  assert.ok(all.length > scoped.length, '不传 scope 时另一个项目也能被搜到');

  assert.equal(searchSpans(db, { query: '情感参数', scope: SCOPE, limit: 1 }).length, 1);

  assert.deepEqual(searchSpans(db, { query: '情感参数', scope: SCOPE, threshold: 1.01 }), []);
  assert.equal(searchSpans(db, { query: '情感参数', scope: SCOPE, threshold: 0 }).length, scoped.length);

  // 第二个 span 的 bigram 命中也应能搜到
  assert.ok(ids.length === 3);
});

test('searchSpans：有 queryVec 时向量召回 + RRF 合并', (t) => {
  const db = makeDb(t);
  const ids = seed(db);
  // 第一条：词法相关，向量 [1,0]；第三条：词法无关，向量与 query [1,0] 也接近
  saveSpanVectors(db, [
    { span_id: ids[0], model: 'test', vec: [1, 0] },
    { span_id: ids[2], model: 'test', vec: [1, 1] },
  ]);

  const hybrid = searchSpans(db, {
    query: '情感参数',
    scope: SCOPE,
    queryVec: new Float32Array([1, 0]),
  });
  assert.ok(hybrid.length >= 2, '向量召回的 span 应与词法结果合并');
  assert.equal(hybrid[0].span.id, ids[0], '词法 + 向量双料第一');
  const merged = hybrid.find((item) => item.span.id === ids[2]);
  assert.ok(merged, '词法未命中但向量命中的 span 也要返回');
  assert.match(merged.reasons.join(' '), /cosine=/);
  assert.match(merged.reasons.join(' '), /rrf=/);
  assert.ok(hybrid[0].score >= hybrid[1].score);

  // 只有向量命中（词法 0 结果）时也能返回
  saveSpanVectors(db, [{ span_id: ids[1], model: 'test', vec: [0, 1] }]);
  const vectorOnly = searchSpans(db, {
    query: '完全不存在的东西',
    scope: SCOPE,
    queryVec: new Float32Array([0, 1]),
  });
  assert.ok(vectorOnly.length >= 1);
  assert.equal(vectorOnly[0].span.id, ids[1]);
  assert.match(vectorOnly[0].reasons.join(' '), /match=vector/);
});

test('searchSpans：queryVec 长度不对时不让向量路径崩掉', (t) => {
  const db = makeDb(t);
  const ids = seed(db);
  saveSpanVectors(db, [{ span_id: ids[0], model: 'test', vec: [1, 0] }]);

  const results = searchSpans(db, {
    query: '情感参数',
    scope: SCOPE,
    queryVec: new Float32Array([1, 0, 0]),
  });
  // 长度不等 → cosine 0 → 没有向量候选，退回纯词法
  assert.equal(results[0].span.id, ids[0]);
  assert.match(results[0].reasons.join(' '), /match=phrase/);
});
