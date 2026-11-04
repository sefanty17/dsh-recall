import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core/db.js';
import {
  upsertFact,
  listFacts,
  factHistory,
  markVerified,
} from '../src/core/facts.js';
import { createService } from '../src/core/service.js';

const SCOPE = 'D:\\personal_vibe\\dsh-recall';

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function fact(overrides = {}) {
  return {
    key: 'pkg-manager',
    value: 'pnpm',
    scope: SCOPE,
    kind: 'preference',
    author: 'rule',
    ...overrides,
  };
}

test('同 key 同值：只刷新 verified_at，不新增事实', (t) => {
  const db = makeDb(t);

  const first = upsertFact(db, fact({
    quote: '以后统一用 pnpm',
    since: 1000,
    created_at: 1000,
  }));
  assert.equal(first.superseded, null);
  assert.equal(first.fact.value, 'pnpm');
  assert.equal(first.fact.status, 'active');
  assert.equal(typeof first.fact.id, 'string');
  assert.ok(first.fact.id.length > 0);

  const again = upsertFact(db, fact({
    quote: '以后统一用 pnpm',
    author: 'user',
    verified: true,
    verified_at: 2000,
    created_at: 2000,
  }));
  assert.equal(again.superseded, null);
  assert.equal(again.fact.id, first.fact.id, '同值不应产生新 id');
  assert.equal(again.fact.verified, 1);
  assert.equal(again.fact.verified_at, 2000);

  const active = listFacts(db, { scope: SCOPE });
  assert.equal(active.length, 1, 'active 只应有一条');
  assert.equal(active[0].id, first.fact.id);

  assert.equal(listFacts(db, { scope: SCOPE, status: 'all' }).length, 1);
  assert.equal(factHistory(db, { key: 'pkg-manager', scope: SCOPE }).length, 1);
});

test('不同值产生 supersede 链，history 按创建时间升序', (t) => {
  const db = makeDb(t);

  const v1 = upsertFact(db, fact({ value: 'npm', created_at: 1000, since: 1000 }));
  assert.equal(v1.superseded, null);

  const v2 = upsertFact(db, fact({ value: 'pnpm', kind: 'decision', author: 'user', created_at: 2000, since: 2000 }));
  assert.equal(v2.superseded, v1.fact.id);
  assert.equal(v2.fact.supersedes, v1.fact.id);

  const oldV1 = listFacts(db, { scope: SCOPE, status: 'superseded' });
  assert.equal(oldV1.length, 1);
  assert.equal(oldV1[0].id, v1.fact.id);
  assert.equal(oldV1[0].status, 'superseded');
  assert.equal(oldV1[0].superseded_by, v2.fact.id);

  const active = listFacts(db, { scope: SCOPE });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, v2.fact.id);

  const v3 = upsertFact(db, fact({ value: 'yarn', kind: 'decision', created_at: 3000, since: 3000 }));
  assert.equal(v3.superseded, v2.fact.id);
  assert.equal(v3.fact.supersedes, v2.fact.id);

  const history = factHistory(db, { key: 'pkg-manager', scope: SCOPE });
  assert.deepEqual(history.map((row) => row.value), ['npm', 'pnpm', 'yarn']);
  assert.deepEqual(history.map((row) => row.status), ['superseded', 'superseded', 'active']);
  assert.deepEqual(history.map((row) => row.created_at), [1000, 2000, 3000]);
  assert.equal(history[0].superseded_by, v2.fact.id);
  assert.equal(history[1].superseded_by, v3.fact.id);
});

test('listFacts 支持 scope / status / key 过滤，不同 scope 互不干扰', (t) => {
  const db = makeDb(t);
  upsertFact(db, fact({ value: 'pnpm', created_at: 1000 }));
  upsertFact(db, fact({ value: 'npm', scope: 'D:\\other', created_at: 2000 }));
  upsertFact(db, fact({ key: 'test-command', value: 'vitest', created_at: 3000 }));

  assert.equal(listFacts(db, { scope: SCOPE }).length, 2);
  assert.equal(listFacts(db, { scope: SCOPE, key: 'pkg-manager' }).length, 1);
  assert.equal(listFacts(db, { scope: 'D:\\other' }).length, 1);
  assert.equal(listFacts(db, { scope: 'D:\\other' })[0].value, 'npm');
  assert.equal(listFacts(db, { status: 'all' }).length, 3);

  // 未给 scope 时默认落到 global
  const globalFact = upsertFact(db, fact({ key: 'branch-policy', value: 'trunk', scope: undefined, created_at: 4000 }));
  assert.equal(globalFact.fact.scope, 'global');
  assert.equal(listFacts(db, { scope: 'global' }).length, 1);
});

test('markVerified 更新校验标记，未知 id 返回 null', (t) => {
  const db = makeDb(t);
  const created = upsertFact(db, fact({ quote: '以后统一用 pnpm' }));
  assert.equal(created.fact.verified, 0);

  const marked = markVerified(db, created.fact.id, 12345);
  assert.ok(marked);
  assert.equal(marked.verified, 1);
  assert.equal(marked.verified_at, 12345);

  assert.equal(markVerified(db, 'missing-id', 1), null);
});

test('never-use 是多值键：不同约束并存、同值只刷新', async (t) => {
  const db = makeDb(t);
  const mk = (value, overrides = {}) => fact({
    key: 'never-use',
    kind: 'constraint',
    value,
    author: 'user',
    ...overrides,
  });

  const first = upsertFact(db, mk('markdown', { created_at: 1000, since: 1000 }));
  const second = upsertFact(db, mk('dead_code', { created_at: 2000, since: 2000 }));
  const third = upsertFact(db, mk('emoji', { created_at: 3000, since: 3000 }));
  for (const result of [first, second, third]) {
    assert.equal(result.superseded, null, '约束之间不应互相 supersede');
  }

  assert.equal(listFacts(db, { scope: SCOPE, key: 'never-use' }).length, 3);
  assert.equal(listFacts(db, { scope: SCOPE, status: 'superseded' }).length, 0);
  assert.deepEqual(
    listFacts(db, { scope: SCOPE, key: 'never-use' }).map((row) => row.value).sort(),
    ['dead_code', 'emoji', 'markdown'],
  );

  // 同值重复写入 -> 不新增，只刷新 verified_at / verified
  const again = upsertFact(db, mk('markdown', {
    created_at: 4000,
    verified: true,
    verified_at: 4000,
  }));
  assert.equal(again.superseded, null);
  assert.equal(again.fact.id, first.fact.id, '同值应复用旧行');
  assert.equal(again.fact.status, 'active');
  assert.equal(again.fact.verified, 1);
  assert.equal(again.fact.verified_at, 4000);
  assert.equal(listFacts(db, { scope: SCOPE, key: 'never-use' }).length, 3);

  // history 三条都在，且都是 active
  const history = factHistory(db, { key: 'never-use', scope: SCOPE });
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((row) => row.value), ['markdown', 'dead_code', 'emoji']);
  assert.deepEqual(history.map((row) => row.status), ['active', 'active', 'active']);

  // state 能列全
  const state = String(await createService({ db, scope: SCOPE }).state());
  assert.match(state, /3 active facts/);
  for (const value of ['markdown', 'dead_code', 'emoji']) {
    assert.match(state, new RegExp(value));
  }
});

test('单值键行为不变：pkg-manager pnpm -> bun 仍然 supersede', (t) => {
  const db = makeDb(t);
  const pnpm = upsertFact(db, fact({ value: 'pnpm', created_at: 1000 }));
  const bun = upsertFact(db, fact({ value: 'bun', created_at: 2000 }));

  assert.equal(bun.superseded, pnpm.fact.id);
  assert.equal(bun.fact.supersedes, pnpm.fact.id);
  assert.equal(listFacts(db, { scope: SCOPE }).length, 1);
  assert.equal(listFacts(db, { scope: SCOPE })[0].value, 'bun');

  const history = factHistory(db, { key: 'pkg-manager', scope: SCOPE });
  assert.deepEqual(history.map((row) => [row.value, row.status]), [
    ['pnpm', 'superseded'],
    ['bun', 'active'],
  ]);
});

test('约束按 value 去重：同值不同 quote 仍合并', (t) => {
  const db = makeDb(t);
  const mk = (quote, created_at) => fact({
    key: 'never-use',
    kind: 'constraint',
    value: 'high',
    author: 'user',
    quote,
    created_at,
  });

  const first = upsertFact(db, mk('不许标 high**', 1000));
  const second = upsertFact(db, mk('不要标 high 壮胆', 2000));
  assert.equal(second.fact.id, first.fact.id, '同一约束换句话说不应重复成两条');
  assert.equal(listFacts(db, { scope: SCOPE, key: 'never-use' }).length, 1);
});

test('note 是多值键：不同 quote 各自 active，同 quote 只刷新', async (t) => {
  const db = makeDb(t);
  const mk = (quote, overrides = {}) => fact({
    key: 'note',
    value: null,
    kind: 'fact',
    author: 'llm',
    quote,
    ...overrides,
  });

  const first = upsertFact(db, mk('第一条 note 的原文', { created_at: 1000 }));
  const second = upsertFact(db, mk('第二条 note 的原文', { created_at: 2000 }));
  const third = upsertFact(db, mk('第三条 note 的原文', { created_at: 3000 }));
  for (const result of [first, second, third]) {
    assert.equal(result.superseded, null, 'note 之间不应互相 supersede');
  }

  assert.equal(listFacts(db, { scope: SCOPE, key: 'note' }).length, 3);
  assert.equal(listFacts(db, { scope: SCOPE, status: 'superseded' }).length, 0);

  // note 不进常驻状态表
  const state = String(await createService({ db, scope: SCOPE }).state());
  assert.match(state, /0 active facts/);

  // 同一条 note 重复写入 -> 不新增，只刷新
  const again = upsertFact(db, mk('第二条 note 的原文', {
    created_at: 4000,
    verified_at: 4000,
  }));
  assert.equal(again.superseded, null);
  assert.equal(again.fact.id, second.fact.id, '同 quote 应复用旧行');
  assert.equal(again.fact.verified_at, 4000);
  assert.equal(listFacts(db, { scope: SCOPE, key: 'note' }).length, 3);

  const history = factHistory(db, { key: 'note', scope: SCOPE });
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((row) => row.quote), [
    '第一条 note 的原文',
    '第二条 note 的原文',
    '第三条 note 的原文',
  ]);
  assert.deepEqual(history.map((row) => row.status), ['active', 'active', 'active']);
});
