import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core/db.js';
import { segmentCJK } from '../src/core/chunk.js';
import {
  search,
  foldVersions,
  neighbors,
  tokenizeQuery,
  buildMatchExpressions,
  buildQueryPlan,
  extractCjkBigrams,
  extractLatinTokens,
} from '../src/core/search.js';
import { createService, extractQuotes, extractRefs, parseKeyValue } from '../src/core/service.js';

// ---------------------------------------------------------------------------
// 固定语料：1 个 session（本项目）+ 1 个 session（别的项目）
// 中文按字切分后入库，模拟 ingest 的写入结果。
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const CWD = 'D:\\personal_vibe\\dsh-recall';
const OTHER_CWD = 'D:\\personal_vibe\\other';
const S1 = '019c6e8f-aaaa-7bbb-8ccc-000000000001';
const S2 = '019c6e8f-bbbb-7bbb-8ccc-000000000002';
const T0 = new Date(2026, 2, 5, 10, 20).getTime(); // 本地 2026-03-05 10:20

const EVENTS = [
  {
    seq: 1,
    type: 'user/message',
    time: T0 - 2 * DAY,
    surface: 'current',
    author: 'user',
    text: '我们决定用 pnpm 作为包管理器',
  },
  {
    seq: 2,
    type: 'assistant/message',
    time: T0 - 2 * DAY + 60_000,
    surface: 'current',
    author: 'assistant',
    text: '好的，pnpm 更快，lockfile 也更稳定',
  },
  {
    seq: 3,
    type: 'user/message',
    time: T0 - 1 * DAY,
    surface: 'shadowed', // 被压缩掉的原文，仍然必须能搜到
    author: 'user',
    text: 'npm 装不上，lockfile 跟 CI 冲突',
  },
  {
    seq: 4,
    type: 'assistant/message',
    time: T0,
    surface: null, // surface 为 NULL 的行也不能被排除
    author: 'assistant',
    text: '改用 pnpm-lock 吧，CI 只认 pnpm-lock.yaml',
  },
  {
    seq: 5,
    type: 'user/message',
    time: T0 + 60_000,
    surface: 'current',
    author: 'user',
    text: '跑测试用 node --test 就行',
  },
];

const FACTS = [
  {
    id: 'f-active',
    key: 'pkg-manager',
    value: 'pnpm',
    scope: CWD,
    kind: 'decision',
    status: 'active',
    since: T0 - 2 * DAY,
    quote: '我们决定用 pnpm 作为包管理器',
    author: 'user',
    verified: 1,
    evidence_session: S1,
    evidence_seq: 1,
    created_at: T0 - 2 * DAY,
  },
  {
    id: 'f-old',
    key: 'pkg-manager',
    value: 'npm',
    scope: CWD,
    kind: 'decision',
    status: 'superseded',
    since: T0 - 8 * DAY,
    quote: 'npm 装不上，lockfile 跟 CI 冲突',
    author: 'user',
    verified: 1,
    evidence_session: S1,
    evidence_seq: 3,
    superseded_by: 'f-active',
    created_at: T0 - 8 * DAY,
  },
];

let nextUnitId = 0;

function addSession(db, { id, cwd, createdAt }) {
  db.prepare(
    'INSERT INTO sessions (id, path, cwd, created_at, event_count) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `C:/sessions/${id}.v3.jsonl.zstd`, cwd, createdAt, 0);
}

function addEvent(db, { sessionId, event }) {
  db.prepare(
    `INSERT INTO events (session_id, seq, type, time, surface, author, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, event.seq, event.type, event.time, event.surface, event.author, event.text);
}

function addUnit(db, { sessionId, seq, start = 0, end = null, text, time, author, surface }) {
  const id = (nextUnitId += 1);
  const stop = end == null ? text.length - 1 : end;
  db.prepare(
    `INSERT INTO units (id, session_id, seq, start, end, text, time, author, surface)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, seq, start, stop, text, time, author, surface);
  db.prepare('INSERT INTO unit_fts (search_text, unit_id) VALUES (?, ?)').run(
    segmentCJK(text),
    id,
  );
  return id;
}

function addFact(db, f) {
  db.prepare(
    `INSERT INTO facts
       (id, key, value, scope, kind, status, since, verified_at, drift, quote, note, author,
        verified, evidence_session, evidence_seq, span_start, span_end, supersedes, superseded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.id,
    f.key,
    f.value,
    f.scope,
    f.kind,
    f.status,
    f.since,
    null,
    null,
    f.quote,
    null,
    f.author,
    f.verified,
    f.evidence_session,
    f.evidence_seq,
    0,
    f.quote.length,
    null,
    f.superseded_by ?? null,
    f.created_at,
  );
}

function buildDb() {
  const db = openDb(':memory:');
  addSession(db, { id: S1, cwd: CWD, createdAt: T0 - 10 * DAY });
  addSession(db, { id: S2, cwd: OTHER_CWD, createdAt: T0 - 10 * DAY });

  for (const event of EVENTS) {
    addEvent(db, { sessionId: S1, event });
    addUnit(db, {
      sessionId: S1,
      seq: event.seq,
      text: event.text,
      time: event.time,
      author: event.author,
      surface: event.surface,
    });
  }

  // 同一 seq 的第二个分块（chunk 重叠），用于验证 foldVersions 的 (session, seq) 折叠。
  addUnit(db, {
    sessionId: S1,
    seq: 2,
    start: 3,
    text: EVENTS[1].text.slice(3),
    time: EVENTS[1].time,
    author: 'assistant',
    surface: 'current',
  });

  // 别的项目：同名内容，用来验证 scope 过滤。
  addEvent(db, {
    sessionId: S2,
    event: {
      seq: 1,
      type: 'user/message',
      time: T0 - DAY,
      surface: 'current',
      author: 'user',
      text: '这个项目也用 pnpm',
    },
  });
  addUnit(db, {
    sessionId: S2,
    seq: 1,
    text: '这个项目也用 pnpm',
    time: T0 - DAY,
    author: 'user',
    surface: 'current',
  });

  for (const fact of FACTS) addFact(db, fact);
  return db;
}

const db = buildDb();

function seqsOf(hits) {
  return hits.map((h) => h.unit.seq);
}

// ---------------------------------------------------------------------------
// 查询构造
// ---------------------------------------------------------------------------

test('buildMatchExpressions：phrase → 中文 bigram → token 三级回退', () => {
  assert.deepEqual(buildMatchExpressions('包管理器'), [
    '"包 管 理 器"',
    '"包 管" OR "管 理" OR "理 器"',
  ]);

  const mixed = buildMatchExpressions('npm 装不上');
  assert.equal(mixed[0], '"npm 装 不 上"');
  assert.equal(mixed[1], '"npm" OR "装 不" OR "不 上"', 'bigram 回退要混入拉丁词');
  assert.equal(mixed[2], '"npm" OR "装 不 上"', 'token 回退保留原文分词');

  // 需求里的原例：latin token 排在最前
  assert.equal(
    buildMatchExpressions('pnpm 包管理器')[1],
    '"pnpm" OR "包 管" OR "管 理" OR "理 器"',
  );

  // 纯拉丁：不产生 bigram，也不做无意义的重试
  assert.deepEqual(buildMatchExpressions('vitest'), ['"vitest"']);
});

test('extractCjkBigrams：滑动窗口 + 去重', () => {
  assert.deepEqual(extractCjkBigrams('包管理器用哪个'), [
    '包管',
    '管理',
    '理器',
    '器用',
    '用哪',
    '哪个',
  ]);
  assert.deepEqual(extractCjkBigrams('测试'), ['测试']);
  assert.deepEqual(extractCjkBigrams('vitest'), []);
});

test('extractLatinTokens：从粘连文本里也能抠出拉丁词', () => {
  assert.deepEqual(extractLatinTokens('pnpm用哪个'), ['pnpm']);
  assert.deepEqual(extractLatinTokens('用哪个'), []);
  assert.deepEqual(extractLatinTokens('pnpm PNPM vitest'), ['pnpm', 'vitest']);
});

test('tokenizeQuery：按空白与中文标点切词并去重', () => {
  assert.deepEqual(tokenizeQuery('npm，pnpm；lockfile'), ['npm', 'pnpm', 'lockfile']);
  assert.deepEqual(tokenizeQuery('  '), []);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('中文查询「包管理器」能命中（按字切分）', () => {
  const hits = search(db, { query: '包管理器', scope: CWD });
  assert.ok(hits.length >= 1, '应当命中「我们决定用 pnpm 作为包管理器」');
  assert.equal(hits[0].unit.seq, 1);
  assert.equal(hits[0].session.cwd, CWD);
  assert.ok(hits[0].unit.text.includes('包管理器'));
});

test('中文查询命中时挂上对应 fact，并加 quote 权重', () => {
  const [hit] = search(db, { query: '包管理器', scope: CWD });
  assert.ok(hit.fact, '命中引文的 unit 应当挂上 fact');
  assert.equal(hit.fact.key, 'pkg-manager');
  assert.equal(hit.fact.status, 'active');
  assert.ok(hit.reasons.some((r) => r.startsWith('quote+0.15')));
});

test('英文查询 pnpm 能命中，且同一事件的不同分块都会返回', () => {
  const hits = search(db, { query: 'pnpm', scope: CWD });
  assert.ok(hits.length >= 3);
  assert.ok(seqsOf(hits).includes(1));
  assert.ok(seqsOf(hits).includes(2));
  // seq 2 有两个 unit（重叠分块）→ 未经 foldVersions 时会出现两条
  assert.equal(seqsOf(hits).filter((s) => s === 2).length, 2);
});

test('surface 为 NULL 的 unit 不会被排除', () => {
  const hits = search(db, { query: 'CI', scope: CWD });
  assert.ok(seqsOf(hits).includes(4), 'surface=NULL 的 seq 4 也应当能搜到');
});

test('scope 过滤：只返回本项目 session', () => {
  const mine = search(db, { query: 'pnpm', scope: CWD });
  assert.ok(mine.length > 0);
  assert.ok(mine.every((h) => h.session.cwd === CWD));

  const other = search(db, { query: 'pnpm', scope: OTHER_CWD });
  assert.ok(other.length > 0);
  assert.ok(other.every((h) => h.session.cwd === OTHER_CWD));

  const global = search(db, { query: 'pnpm', scope: 'global', limit: 20 });
  assert.equal(new Set(global.map((h) => h.session.cwd)).size, 2);
});

test('无结果返回空数组（含超长乱码 query）', () => {
  assert.deepEqual(search(db, { query: '量子纠缠超导材料zzz', scope: CWD }), []);
  assert.deepEqual(search(db, { query: '   ', scope: CWD }), []);
  assert.deepEqual(search(db, { query: 'pnpm', scope: 'D:\\nowhere' }), []);
});

test('整句查不到时回退到中文 bigram（并记录命中数）', () => {
  const hits = search(db, { query: '量子 包管理器', scope: CWD });
  assert.ok(hits.length >= 1, 'bigram 回退应当命中「包管理器」');
  assert.ok(hits[0].reasons.includes('bigram-fallback'));
  assert.ok(
    hits[0].reasons.some((r) => /^bigram:\d+\/\d+$/.test(r)),
    `reasons 应带 bigram 命中数：${hits[0].reasons.join(' | ')}`,
  );
});

// ---------------------------------------------------------------------------
// P0：中文自然语言问句必须能召回
// ---------------------------------------------------------------------------

test('P0：包管理器用哪个 → 命中含「包管理器」的 unit', () => {
  // 整句 phrase 在原文里不存在：必须靠 bigram 回退
  const hits = search(db, { query: '包管理器用哪个', scope: CWD });
  assert.ok(hits.length >= 1, '自然语言问句不应 0 命中');
  assert.ok(hits.some((h) => h.unit.text.includes('包管理器')));
  const top = hits.find((h) => h.unit.text.includes('包管理器'));
  assert.ok(top.reasons.includes('bigram-fallback'));
  assert.ok(
    top.reasons.includes('bigram:3/6'),
    `应命中 3/6 个 bigram，实际：${top.reasons.join(' | ')}`,
  );
});

test('P0：这个项目测试怎么跑 → 命中含「测试」的 unit', () => {
  const hits = search(db, { query: '这个项目测试怎么跑', scope: CWD });
  assert.ok(hits.length >= 1, '自然语言问句不应 0 命中');
  assert.ok(hits.some((h) => h.unit.text.includes('测试')));
  assert.ok(hits[0].reasons.includes('bigram-fallback'));
});

test('P0：pnpm 用哪个 → 拉丁词 + bigram 混用仍能命中', () => {
  const hits = search(db, { query: 'pnpm 用哪个', scope: CWD });
  assert.ok(hits.length >= 1);
  assert.ok(seqsOf(hits).includes(1));
  // 「用哪个」两个 bigram 都是停用字，靠拉丁词兜住
  assert.ok(buildMatchExpressions('pnpm 用哪个').some((e) => e.includes('"pnpm"')));
});

test('P0：纯拉丁查询不受 bigram 影响', () => {
  assert.deepEqual(buildMatchExpressions('vitest'), ['"vitest"']);
  assert.deepEqual(search(db, { query: 'vitest', scope: CWD }), []);
});

test('P0：bigram 全是停用字时不崩，返回 ≤ limit', () => {
  const hits = search(db, { query: '用哪个', scope: CWD, limit: 8 });
  assert.ok(Array.isArray(hits));
  assert.ok(hits.length <= 8);
  // 没有可用的 bigram / 拉丁词 → 只剩整句 phrase 一次尝试
  assert.deepEqual(buildMatchExpressions('用哪个'), ['"用 哪 个"']);
  assert.equal(buildQueryPlan('用哪个').attempts.length, 1);
});

test('P0 回归：命中更多 bigram 的 unit 必须排前面（bm25 方向）', () => {
  // FTS5 的 bm25 越负越相关。曾经写成 1/(1+|rank|)，导致弱匹配排第一。
  const small = openDb(':memory:');
  const docs = [
    '这个项目的包管理器用 pnpm', // 命中 包管/管理/理器/器用 = 4/6
    '权限管理说明：这里只是泛泛而谈', // 只命中 管理 = 1/6
    '无关内容之一：今天天气不错',
    '无关内容之三：迁移脚本还没写',
    '无关内容之四：日志级别调一下',
    '无关内容之五：数据库连接池',
  ];
  addSession(small, { id: 'sx', cwd: 'C:\\x', createdAt: T0 });
  docs.forEach((text, i) => {
    addEvent(small, {
      sessionId: 'sx',
      event: { seq: i + 1, type: 'user/message', time: T0, surface: 'current', author: 'user', text },
    });
    addUnit(small, {
      sessionId: 'sx',
      seq: i + 1,
      text,
      time: T0,
      author: 'user',
      surface: 'current',
    });
  });

  const hits = search(small, { query: '包管理器用哪个', scope: 'C:\\x', limit: 8 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].unit.text, docs[0], '命中 4 个 bigram 的文档应排第一');

  const bm25Of = (hit) => Number(hit.reasons.find((r) => r.startsWith('bm25=')).slice(5));
  assert.ok(bm25Of(hits[0]) > bm25Of(hits[1]), '越相关的 bm25 归一化值必须越大');
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(
    hits[0].reasons.includes('bigram:4/6'),
    `强命中应记 4/6：${hits[0].reasons.join(' | ')}`,
  );
});

test('P0 回归：3/8 覆盖的长 unit 必须压过 1/8 覆盖的短 unit', () => {
  // 复刻真实库里的错排序：15 字短 unit（只命中「怎么」）靠 bm25 长度归一化排第一，
  // 815 字长 unit（命中 项目/测试/怎么）排第八。覆盖率项必须把顺序正过来。
  const small = openDb(':memory:');
  addSession(small, { id: 'sx', cwd: 'C:\\x', createdAt: T0 });

  const longText = `项目背景。测试计划。怎么部署。${'补充说明'.repeat(200)}`; // 约 815 字，命中 3/8
  const shortText = '先告诉我剩下的东西是怎么实现的'; // 17 字，只命中「怎么」= 1/8
  const filler = '无关内容'.repeat(158); // 约 632 字，制造与真实语料同量级的 avgdl

  const docs = [longText, shortText, ...Array.from({ length: 18 }, () => filler)];
  docs.forEach((text, i) => {
    addEvent(small, {
      sessionId: 'sx',
      event: {
        seq: i + 1,
        type: 'user/message',
        time: T0,
        surface: 'current',
        author: 'user',
        text,
      },
    });
    addUnit(small, {
      sessionId: 'sx',
      seq: i + 1,
      text,
      time: T0,
      author: 'user',
      surface: 'current',
    });
  });

  const hits = search(small, { query: '这个项目测试怎么跑', scope: 'C:\\x', limit: 8 });
  assert.equal(hits.length, 2, '只有长/短两个 unit 命中');
  assert.equal(hits[0].unit.text, longText, '3/8 覆盖的长 unit 必须排第一');
  assert.ok(hits[0].unit.text.length > hits[1].unit.text.length);

  const reasonsOf = (hit) => hit.reasons.join(' | ');
  assert.ok(hits[0].reasons.includes('bigram:3/8'), reasonsOf(hits[0]));
  assert.ok(hits[0].reasons.includes('coverage:0.375'), reasonsOf(hits[0]));
  assert.ok(hits[1].reasons.includes('bigram:1/8'), reasonsOf(hits[1]));
  assert.ok(hits[1].reasons.includes('coverage:0.125'), reasonsOf(hits[1]));
});

test('P0：limit 很小时 bigram 候选池仍有 32 条，长 unit 不被挡在池外', () => {
  // cap = limit*4 时 limit=1 只会取 bm25 前 4 条，长 unit（覆盖率最高）会缺席。
  const small = openDb(':memory:');
  addSession(small, { id: 'sx', cwd: 'C:\\x', createdAt: T0 });
  const longText = `项目背景。测试计划。怎么部署。${'补充说明'.repeat(200)}`; // 3/8
  const docs = [longText, ...Array.from({ length: 20 }, () => '先告诉我怎么实现')]; // 各 1/8，且更短

  docs.forEach((text, i) => {
    addEvent(small, {
      sessionId: 'sx',
      event: {
        seq: i + 1,
        type: 'user/message',
        time: T0,
        surface: 'current',
        author: 'user',
        text,
      },
    });
    addUnit(small, {
      sessionId: 'sx',
      seq: i + 1,
      text,
      time: T0,
      author: 'user',
      surface: 'current',
    });
  });

  const hits = search(small, { query: '这个项目测试怎么跑', scope: 'C:\\x', limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].unit.text, longText, '候选池被截断时这条长 unit 会缺席');
});

test('默认 active only：落在 superseded 事实上的证据被过滤', () => {
  const activeOnly = search(db, { query: 'lockfile', scope: CWD });
  assert.ok(seqsOf(activeOnly).includes(2));
  assert.ok(!seqsOf(activeOnly).includes(3), 'seq 3 的引文属于已废弃事实');

  const withStale = search(db, { query: 'lockfile', scope: CWD, includeSuperseded: true });
  const stale = withStale.find((h) => h.unit.seq === 3);
  assert.ok(stale, 'includeSuperseded 时应返回 seq 3');
  assert.equal(stale.fact.status, 'superseded');
});

test('limit 生效，且结果按合成分数降序', () => {
  const one = search(db, { query: 'pnpm', scope: CWD, limit: 1 });
  assert.equal(one.length, 1);
  const hits = search(db, { query: 'pnpm', scope: CWD, limit: 8 });
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score >= hits[i].score);
  }
  assert.ok(hits[0].reasons.length > 0);
});

test('Hit 结构完整：unit / event / session / score / reasons', () => {
  const [hit] = search(db, { query: '包管理器', scope: CWD });
  assert.equal(typeof hit.unit.text, 'string');
  assert.equal(typeof hit.unit.start, 'number');
  assert.equal(typeof hit.unit.end, 'number');
  assert.equal(hit.session.id, S1);
  assert.equal(hit.event.author, 'user');
  assert.equal(typeof hit.score, 'number');
  assert.ok(Array.isArray(hit.reasons));
});

// ---------------------------------------------------------------------------
// foldVersions
// ---------------------------------------------------------------------------

test('foldVersions：同一 (session_id, seq) 只留分数最高的一条', () => {
  const raw = search(db, { query: 'pnpm', scope: CWD, limit: 8 });
  const folded = foldVersions(db, raw);
  const seqKeys = folded.map((h) => `${h.unit.session_id}#${h.unit.seq}`);
  assert.equal(new Set(seqKeys).size, seqKeys.length);
  assert.equal(folded.length, new Set(seqKeys).size);
});

test('foldVersions：前 40 字符相同的文本只留一条', () => {
  const base = '这是一段足够长的共用前缀文本，用来验证前四十字符折叠逻辑，后面开始出现差异并将它们区分开来';
  assert.ok(base.length > 40, '测试前提：base 必须超过 40 字');
  const hits = [
    { unit: { session_id: 's1', seq: 1, text: base }, score: 0.9 },
    { unit: { session_id: 's1', seq: 1, text: '同一事件的重叠分块', start: 5 }, score: 0.5 },
    { unit: { session_id: 's1', seq: 2, text: `${base}（甲）` }, score: 0.7 },
    { unit: { session_id: 's1', seq: 2, text: `${base}（乙）`, start: 3 }, score: 0.6 },
    { unit: { session_id: 's1', seq: 3, text: '完全不同的另一段文本，前缀不一样' }, score: 0.4 },
  ];
  const folded = foldVersions(null, hits);
  assert.deepEqual(
    folded.map((h) => h.unit.seq),
    [1, 3],
  );
  assert.equal(folded[0].score, 0.9, '保留分数最高的那条');
});

test('foldVersions：空输入不炸', () => {
  assert.deepEqual(foldVersions(db, []), []);
  assert.deepEqual(foldVersions(db, undefined), []);
});

// ---------------------------------------------------------------------------
// neighbors
// ---------------------------------------------------------------------------

test('neighbors：取同一 session 的 seq 前后各一条', () => {
  const hits = search(db, { query: 'lockfile', scope: CWD, includeSuperseded: true });
  const hit = hits.find((h) => h.unit.seq === 3);
  assert.ok(hit);
  const near = neighbors(db, hit, { before: 1, after: 1 });
  assert.deepEqual(
    near.map((n) => n.seq),
    [2, 4],
  );
  assert.equal(near[0].direction, 'before');
  assert.equal(near[1].direction, 'after');
  assert.ok(near[0].text.includes('pnpm 更快'));
  assert.ok(near[1].text.includes('pnpm-lock'));
});

test('neighbors：origin 附近没有事件时返回空，不越界', () => {
  const hits = search(db, { query: '包管理器', scope: CWD });
  const near = neighbors(db, hits[0], { before: 0, after: 0 });
  assert.deepEqual(near, []);
  assert.deepEqual(neighbors(db, null), []);
  assert.deepEqual(neighbors(db, { unit: { seq: 99 } }), []);
});

// ---------------------------------------------------------------------------
// service 门面（五个方法都返回字符串，错误不抛给上层）
// ---------------------------------------------------------------------------

test('service：state/history/search/read 都返回规定标记的字符串', () => {
  const svc = createService({ db, scope: CWD });

  const state = svc.state();
  assert.ok(state.startsWith('[memory.state]'));
  assert.ok(state.includes('pkg-manager'));

  const history = svc.history('pkg-manager');
  assert.ok(history.startsWith('[memory.history] pkg-manager · 2 versions'));
  assert.ok(history.includes('ACTIVE'));

  const hits = svc.search('包管理器');
  assert.ok(hits.startsWith('[memory.search]'));
  assert.ok(hits.includes('session_event_read'));

  const read = svc.read(S1, 3);
  assert.ok(read.startsWith('[memory.read]'));
  assert.ok(read.includes('TARGET'));
  assert.ok(read.includes('npm 装不上'));
});

test('service：错误参数返回 [memory.error]，不抛异常', () => {
  const svc = createService({ db, scope: CWD });
  const bad = [svc.search(''), svc.history(''), svc.read('', 1), svc.read(S1, 'x'), svc.write('')];
  for (const out of bad) assert.ok(out.startsWith('[memory.error]'), out);
});

test('service.search：前几条命中带邻域上下文，折叠后不重复', () => {
  const svc = createService({ db, scope: CWD });
  const out = svc.search('pnpm', { limit: 8 });
  assert.ok(out.startsWith('[memory.search]'));
  assert.ok(/↳ (前一条|后一条)：/.test(out), '前 3 条命中应带 ±1 上下文');
  const numbered = out.split('\n').filter((line) => /^\d+\. /.test(line));
  const seqs = numbered.map((line) => line.match(/seq (\d+)/)?.[1]).filter(Boolean);
  assert.equal(new Set(seqs).size, seqs.length, '同一 (session, seq) 不应出现两次');
});

test('service.write：引文可在原文验证 → verified=true；换值触发 supersede', () => {
  const fresh = buildDb();
  const svc = createService({ db: fresh, scope: CWD });

  const same = svc.write('pkg-manager = pnpm 「我们决定用 pnpm 作为包管理器」', {
    sessionId: S1,
    seq: 1,
  });
  assert.ok(same.startsWith('[memory.write] ok'));
  assert.ok(same.includes('fact pkg-manager=pnpm'));
  assert.ok(same.includes('verified=true'));
  assert.ok(!same.includes('superseded'), '同值确认不应产生新版本');

  const change = svc.write('pkg-manager = yarn', { sessionId: S1, seq: 1 });
  assert.ok(change.includes('superseded 1'), change);

  const rows = fresh
    .prepare('SELECT * FROM facts WHERE key = ? ORDER BY created_at ASC')
    .all('pkg-manager');
  const active = rows.filter((r) => r.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].value, 'yarn');
});

test('service.write：没有引文 → kind=fact、note=content、verified=false', () => {
  const fresh = buildDb();
  const svc = createService({ db: fresh, scope: CWD });
  const out = svc.write('以后测试都用 node --test');
  assert.ok(out.startsWith('[memory.write] ok'));
  assert.ok(out.includes('verified=false'));

  const rows = fresh.prepare("SELECT * FROM facts WHERE kind = 'fact'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, '以后测试都用 node --test');
  assert.equal(rows[0].quote, null);
});

test('service.write：@seq 唯一时作为证据并校验引文，歧义时不猜', () => {
  const fresh = buildDb();
  const svc = createService({ db: fresh, scope: CWD });

  // seq 3 只在 S1 存在 → 可唯一定位
  const unique = svc.write('「npm 装不上，lockfile 跟 CI 冲突」 @3');
  assert.ok(unique.includes('verified=true'), unique);
  assert.ok(unique.includes('evidence e3'));

  // seq 1 在两个 session 都存在 → 歧义，不猜证据，照写但 verified=false
  const ambiguous = svc.write('「我们决定用 pnpm 作为包管理器」 @1');
  assert.ok(ambiguous.startsWith('[memory.write] ok'));
  assert.ok(ambiguous.includes('verified=false'), ambiguous);
});

test('extractQuotes / extractRefs 软解析', () => {
  assert.deepEqual(extractQuotes('他说「用 pnpm」，另外 `lockfile` 也要'), ['用 pnpm', 'lockfile']);
  const refs = extractRefs('证据 @31 和 @019c6e8f-aaaa-7bbb-8ccc-000000000001:2');
  assert.deepEqual(
    refs.map((r) => [r.sessionId, r.seq]),
    [
      [null, 31],
      [S1, 2],
    ],
  );
});

test('parseKeyValue：引文不吞进 value，叙述引导词不当 key', () => {
  assert.deepEqual(parseKeyValue('pkg-manager = pnpm 「我们决定用 pnpm」'), {
    key: 'pkg-manager',
    value: 'pnpm',
    note: '',
  });
  assert.deepEqual(parseKeyValue('test-command: node --test'), {
    key: 'test-command',
    value: 'node --test',
    note: '',
  });
  assert.deepEqual(parseKeyValue('pkg-manager = "pnpm"'), {
    key: 'pkg-manager',
    value: 'pnpm',
    note: '',
  });
  assert.equal(parseKeyValue('记住：迁移脚本要幂等'), null);
  assert.equal(parseKeyValue('10:20 开会'), null);
  assert.equal(parseKeyValue('随便一句话'), null);
});

test('parseKeyValue：value 右边界——说理词 / 标点 / 空白+中文', () => {
  const a = parseKeyValue('pkg-manager=pnpm 依据：CI 只认 pnpm-lock');
  assert.equal(a.key, 'pkg-manager');
  assert.equal(a.value, 'pnpm');
  assert.equal(a.note, '依据：CI 只认 pnpm-lock');

  const b = parseKeyValue('never-use=npm，lockfile 冲突');
  assert.equal(b.value, 'npm');
  assert.equal(b.note, 'lockfile 冲突', '标点不能留在 note 开头');

  const c = parseKeyValue('pkg-manager=pnpm 改成 bun');
  assert.equal(c.value, 'pnpm');
  assert.equal(c.note, '改成 bun');

  // 没有边界时保持完整值（含空格、连字符）
  assert.deepEqual(parseKeyValue('test-command = node --test').value, 'node --test');
  // 边界在开头 → value 为空，由 write 降级
  assert.equal(parseKeyValue('pkg-manager=依据：CI 只认 pnpm-lock').value, '');
});

test('service.write：value 截到「依据」，余部进 note', () => {
  const fresh = buildDb();
  fresh.exec('DELETE FROM facts');
  const svc = createService({ db: fresh, scope: CWD });

  const out = svc.write('pkg-manager=pnpm 依据：CI 只认 pnpm-lock.yaml');
  assert.ok(out.startsWith('[memory.write] ok'));
  assert.ok(out.includes('fact pkg-manager=pnpm'), out);

  const row = fresh
    .prepare("SELECT * FROM facts WHERE key='pkg-manager' ORDER BY created_at DESC, rowid DESC")
    .get();
  assert.equal(row.value, 'pnpm', 'value 不能被依据吞掉');
  assert.equal(row.note, '依据：CI 只认 pnpm-lock.yaml');
  assert.ok(!row.note.includes('\n'));
});

test('service.write：中文逗号截断 value，note 去掉前导标点', () => {
  const fresh = buildDb();
  fresh.exec('DELETE FROM facts');
  const svc = createService({ db: fresh, scope: CWD });

  svc.write('never-use=npm，lockfile 冲突');
  const row = fresh.prepare("SELECT * FROM facts WHERE key='never-use'").get();
  assert.equal(row.value, 'npm');
  assert.equal(row.note, 'lockfile 冲突');
  assert.equal(row.kind, 'fact');
});

test('service.write：value 为空 → 降级成 note 型事实，不产生空 value 的 typed fact', () => {
  const fresh = buildDb();
  fresh.exec('DELETE FROM facts');
  const svc = createService({ db: fresh, scope: CWD });

  const out = svc.write('pkg-manager=');
  assert.ok(out.startsWith('[memory.write] ok'), out);

  assert.equal(
    fresh.prepare("SELECT COUNT(*) AS n FROM facts WHERE key='pkg-manager'").get().n,
    0,
    '不能产生 key=pkg-manager 且空 value 的 typed fact',
  );
  const notes = fresh.prepare("SELECT * FROM facts WHERE kind='fact'").all();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].value, null);
  assert.ok(notes[0].key.startsWith('note-'), notes[0].key);
  assert.ok(notes[0].note.includes('pkg-manager'), notes[0].note);
});
