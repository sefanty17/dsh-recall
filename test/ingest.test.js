import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/core/db.js';
import { chunkText } from '../src/core/chunk.js';
import {
  computeSurfaces,
  ingestSession,
  ingestAll,
  extractFacts,
} from '../src/core/ingest.js';
import { listFacts } from '../src/core/facts.js';
import { createService } from '../src/core/service.js';

const SESSION_ID = 'sess-test-1';

const EVENT_TEXTS = {
  1: '以后统一用 pnpm，测试都用 vitest。',
  2: '好的，我记住了。',
  3: 'shell {"cmd":"pnpm test"}',
  4: 'EACCES: permission denied Error EACCES',
};

function makeEvents() {
  return [
    {
      seq: 1,
      type: 'user/message',
      time: 1000,
      surfaceOp: 'append',
      data: { content: [{ type: 'text', text: EVENT_TEXTS[1] }] },
    },
    {
      seq: 2,
      type: 'assistant/message',
      time: 1100,
      surfaceOp: 'append',
      data: {
        message: {
          content: [
            // reasoning 不进索引
            { type: 'reasoning', text: '思考中，不应被索引' },
            { type: 'text', text: EVENT_TEXTS[2] },
          ],
        },
      },
    },
    {
      seq: 3,
      type: 'tool/call',
      time: 1200,
      surfaceOp: 'append',
      data: { name: 'shell', arguments: { cmd: 'pnpm test' } },
    },
    {
      seq: 4,
      type: 'tool/result',
      time: 1300,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
      data: {
        // 真实 DSH 结构：data.message.content[] 里再套一层 type=tool-result
        message: {
          content: [{
            type: 'tool-result',
            content: [{ type: 'text', text: 'EACCES: permission denied' }],
          }],
        },
        error: { name: 'Error', code: 'EACCES' },
      },
    },
    {
      seq: 5,
      type: 'system/info',
      time: 1400,
      data: { message: 'session started' },
    },
  ];
}

function header() {
  return { id: SESSION_ID, cwd: 'D:\\personal_vibe\\dsh-recall', createdAt: 900, origin: 'test' };
}

function expectedUnits(extraTexts = []) {
  return Object.values(EVENT_TEXTS)
    .concat(extraTexts)
    .reduce((sum, text) => sum + chunkText(text).length, 0);
}

function count(db, sql, params = []) {
  return Number(db.prepare(sql).get(...params).n);
}

test('computeSurfaces 标记 replace 区间、append 与 log-only', () => {
  const surfaces = computeSurfaces(makeEvents());
  assert.deepEqual([...surfaces.entries()], [
    [1, 'shadowed'],
    [2, 'shadowed'],
    [3, 'shadowed'],
    [4, 'current'],
    [5, 'log-only'],
  ]);
});

test('ingestSession 写入 events / units / FTS，并按 event_count 幂等', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const first = ingestSession(db, { header: header(), events: makeEvents() });
  const expected = expectedUnits();
  assert.equal(first.events, 5);
  assert.equal(first.units, expected);
  assert.equal(first.facts, 2, '事件 1 应抽出 preference pkg-manager 与 test-command');
  assert.ok(expected >= 4, `每类事件至少一个 chunk，实际 ${expected}`);

  // session 元数据
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SESSION_ID);
  assert.equal(session.event_count, 5);
  assert.equal(session.cwd, 'D:\\personal_vibe\\dsh-recall');
  assert.equal(typeof session.ingested_at, 'number');

  // events 元数据 + surface
  const events = db.prepare(
    'SELECT seq, type, surface, author, text FROM events WHERE session_id = ? ORDER BY seq',
  ).all(SESSION_ID);
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((row) => row.surface), ['shadowed', 'shadowed', 'shadowed', 'current', 'log-only']);
  assert.equal(events[0].author, 'user');
  assert.equal(events[1].author, 'assistant');
  assert.equal(events[2].author, 'tool');
  assert.equal(events[3].author, 'tool');
  assert.equal(events[4].text, null, '非 unit 类型不应留下文本');
  assert.equal(events[0].text, EVENT_TEXTS[1]);
  assert.equal(events[3].text, EVENT_TEXTS[4]);

  // units：数量、偏移（units 不再有 search_text 列）
  const units = db.prepare(
    'SELECT * FROM units WHERE session_id = ? ORDER BY seq, start',
  ).all(SESSION_ID);
  assert.equal(units.length, expected);
  assert.equal(Object.hasOwn(units[0], 'search_text'), false, 'units 不应再存 search_text');
  for (const unit of units) {
    assert.ok(unit.text.length > 0);
    assert.equal(typeof unit.start, 'number');
    assert.equal(typeof unit.end, 'number');
    assert.equal(unit.end - unit.start + 1, unit.text.length, 'end 是闭区间');
    assert.ok(['shadowed', 'current'].includes(unit.surface));
  }

  // 中文按字切分（segmentCJK 只写进 FTS）
  const cjkUnit = units.find((unit) => unit.seq === 1);
  const ftsRow = db.prepare('SELECT search_text FROM unit_fts WHERE unit_id = ?').get(cjkUnit.id);
  assert.ok(ftsRow && ftsRow.search_text.length > 0);
  assert.ok(/[\u4e00-\u9fff] [\u4e00-\u9fff]/.test(ftsRow.search_text), ftsRow.search_text);

  // FTS 行与 units 一一对应
  assert.equal(count(db, 'SELECT count(*) AS n FROM unit_fts'), expected);

  // 规则抽取：事实已入库，且 scope = header.cwd
  const activeFacts = listFacts(db, { scope: 'D:\\personal_vibe\\dsh-recall' });
  assert.deepEqual(
    activeFacts.map((row) => row.key).sort(),
    ['pkg-manager', 'test-command'],
  );
  assert.equal(activeFacts.find((row) => row.key === 'pkg-manager').value, 'pnpm');
  assert.equal(activeFacts.find((row) => row.key === 'test-command').value, 'vitest');
  for (const row of activeFacts) {
    assert.equal(row.author, 'user');
    assert.equal(row.verified, 1);
    assert.equal(row.evidence_session, SESSION_ID);
  }

  // 幂等：同 id 同 event_count 直接跳过
  const second = ingestSession(db, { header: header(), events: makeEvents() });
  assert.deepEqual(second, { units: 0, facts: 0, events: 0 });
  assert.equal(count(db, 'SELECT count(*) AS n FROM units WHERE session_id = ?', [SESSION_ID]), expected);
  assert.equal(count(db, 'SELECT count(*) AS n FROM unit_fts'), expected);

  // event_count 变了 -> 全量重灌，不产生重复
  const grown = makeEvents();
  grown.push({
    seq: 6,
    type: 'user/message',
    time: 1500,
    surfaceOp: 'append',
    data: { content: [{ type: 'text', text: '上线前统一用 make deploy。' }] },
  });

  const third = ingestSession(db, { header: header(), events: grown });
  const grownExpected = expectedUnits(['上线前统一用 make deploy。']);
  assert.equal(third.events, 6);
  assert.equal(third.units, grownExpected);
  assert.equal(third.facts, 1, '只有新事件 6 产生新事实，事件 1 的证据去重');
  assert.equal(listFacts(db, { scope: 'D:\\personal_vibe\\dsh-recall' }).length, 3);
  assert.equal(count(db, 'SELECT count(*) AS n FROM units WHERE session_id = ?', [SESSION_ID]), grownExpected);
  assert.equal(count(db, 'SELECT count(*) AS n FROM unit_fts'), grownExpected);
  assert.equal(count(db, 'SELECT count(*) AS n FROM events WHERE session_id = ?', [SESSION_ID]), 6);
  assert.equal(
    db.prepare('SELECT event_count FROM sessions WHERE id = ?').get(SESSION_ID).event_count,
    6,
  );
});

test('缺少 header.id 时抛错；空事件也能建 session', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  assert.throws(() => ingestSession(db, { header: {}, events: [] }), /header\.id/);

  const empty = ingestSession(db, { header: { id: 'empty-sess' }, events: [] });
  assert.deepEqual(empty, { units: 0, facts: 0, events: 0 });
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('empty-sess');
  assert.equal(row.event_count, 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM units WHERE session_id = ?', ['empty-sess']), 0);
});

test('ingestAll 遍历 fixtures 目录，二次执行全部幂等跳过', (t) => {
  const root = fileURLToPath(new URL('../fixtures', import.meta.url));
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const progress = [];
  const stats = ingestAll(db, root, { onProgress: (info) => progress.push(info) });
  assert.ok(stats.files >= 1, 'fixtures 里应有会话文件');
  assert.equal(stats.failed, 0);
  assert.equal(stats.sessions, stats.files);
  assert.ok(stats.events > 0, '应读到事件');
  assert.ok(stats.units > 0, '应写入 units');
  assert.ok(stats.facts > 0, 'fixture 用户消息应抽出事实');
  assert.equal(progress.length, stats.files);
  assert.equal(progress[0].total, stats.files);
  assert.equal(progress[0].done, 1);
  assert.equal(progress[0].error, null);
  assert.equal(progress[0].facts, stats.facts);

  assert.equal(
    count(db, 'SELECT count(*) AS n FROM events'),
    stats.events,
  );
  assert.equal(
    count(db, 'SELECT count(*) AS n FROM units'),
    stats.units,
  );
  assert.equal(
    count(db, 'SELECT count(*) AS n FROM unit_fts'),
    stats.units,
  );
  assert.equal(
    count(db, 'SELECT count(*) AS n FROM facts'),
    stats.facts,
  );

  const again = ingestAll(db, root, {});
  assert.equal(again.failed, 0);
  assert.equal(again.units, 0);
  assert.equal(again.facts, 0);
  assert.equal(again.events, 0);
  assert.equal(again.skipped, again.files);
  assert.equal(count(db, 'SELECT count(*) AS n FROM units'), stats.units);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), stats.facts);
});

test('extractFacts 只扫用户消息，事实可被 service.state 列出', async (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const ctx = { id: 'facts-sess', cwd: 'D:\\proj' };
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1000,
      data: { content: [{ type: 'text', text: '以后统一用 pnpm。' }] },
    },
    {
      // assistant 的消息不参与抽取（否则会写出 pkg-manager=npm 并覆盖 pnpm）
      seq: 2,
      type: 'assistant/message',
      time: 1100,
      data: { message: { content: [{ type: 'text', text: '收到，以后统一用 npm。' }] } },
    },
    {
      seq: 3,
      type: 'user/message',
      time: 1200,
      data: { content: [{ type: 'text', text: '不要动 orders 表。' }] },
    },
    {
      seq: 4,
      type: 'user/message',
      time: 1300,
      data: { content: [{ type: 'text', text: '今天天气不错。' }] },
    },
  ];

  const result = extractFacts(db, { header: ctx, events });
  assert.equal(result.facts, 2, '只有两条用户消息命中规则');

  const facts = listFacts(db, { scope: 'D:\\proj' });
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((row) => row.key).sort(), ['never-use', 'pkg-manager']);

  const pkg = facts.find((row) => row.key === 'pkg-manager');
  assert.equal(pkg.value, 'pnpm');
  assert.equal(pkg.author, 'user');
  assert.equal(pkg.verified, 1);
  assert.equal(pkg.evidence_session, 'facts-sess');
  assert.equal(pkg.evidence_seq, 1);
  assert.equal(pkg.quote, '以后统一用 pnpm');

  const never = facts.find((row) => row.key === 'never-use');
  assert.equal(never.value, 'orders');

  // 重复抽取幂等
  assert.equal(extractFacts(db, { header: ctx, events }).facts, 0);
  assert.equal(listFacts(db, { scope: 'D:\\proj' }).length, 2);

  const service = createService({ db, scope: 'D:\\proj' });
  const state = String(await service.state());
  assert.match(state, /pkg-manager/);
  assert.match(state, /pnpm/);
  assert.match(state, /never-use/);
  assert.match(state, /orders/);
});

test('同一会话 ingest 两次，facts 不增加', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const ctx = { id: 'twice-sess', cwd: 'D:\\proj' };
  const events = [{
    seq: 1,
    type: 'user/message',
    time: 1000,
    data: { content: [{ type: 'text', text: '以后统一用 pnpm。' }] },
  }];

  const first = ingestSession(db, { header: ctx, events });
  assert.equal(first.facts, 1);

  const second = ingestSession(db, { header: ctx, events });
  assert.deepEqual(second, { units: 0, facts: 0, events: 0 });
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 1);

  // 绕过 event_count 快路径：事件数变化后重灌，证据去重仍保证不重复
  const grown = events.concat([{
    seq: 2,
    type: 'user/message',
    time: 2000,
    data: { content: [{ type: 'text', text: '今天天气不错。' }] },
  }]);
  const third = ingestSession(db, { header: ctx, events: grown });
  assert.equal(third.facts, 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 1);
  assert.equal(listFacts(db, { scope: 'D:\\proj' }).length, 1);
});

test('没有合格 value 的候选不写事实（问句也不写）', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const ctx = { id: 'no-value', cwd: 'D:\\proj' };
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1000,
      data: { content: [{ type: 'text', text: '这个方案不行。' }] },
    },
    {
      seq: 2,
      type: 'user/message',
      time: 1100,
      data: { content: [{ type: 'text', text: '不要安装任何东西。' }] },
    },
    {
      seq: 3,
      type: 'user/message',
      time: 1200,
      data: { content: [{ type: 'text', text: '以后统一用 pnpm 吗？' }] },
    },
  ];

  assert.equal(extractFacts(db, { header: ctx, events }).facts, 0);
  assert.equal(count(db, 'SELECT count(*) AS n FROM facts'), 0);
});

test('只抽 source.kind=user 的用户消息（plugin / agent-instructions 跳过）', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const ctx = { id: 'source-kinds', cwd: 'D:\\proj' };
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1000,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '以后统一用 pnpm。' }],
      },
    },
    {
      seq: 2,
      type: 'user/message',
      time: 1100,
      data: {
        source: { kind: 'plugin' },
        content: [{ type: 'text', text: '不要用 npm 或 yarn。' }],
      },
    },
    {
      seq: 3,
      type: 'user/message',
      time: 1200,
      data: {
        source: { kind: 'agent-instructions' },
        content: [{ type: 'text', text: '禁止提交 secrets 文件。' }],
      },
    },
    {
      // source 缺失 -> 视为用户消息（兼容旧日志）
      seq: 4,
      type: 'user/message',
      time: 1300,
      data: { content: [{ type: 'text', text: '不要动 orders 表。' }] },
    },
  ];

  const result = extractFacts(db, { header: ctx, events });
  assert.equal(result.facts, 2, '只有 user 与 source 缺失的两条被抽取');

  const facts = listFacts(db, { scope: 'D:\\proj' });
  assert.deepEqual(facts.map((row) => row.key).sort(), ['never-use', 'pkg-manager']);
  assert.ok(!facts.some((row) => row.evidence_seq === 2 || row.evidence_seq === 3));
  assert.equal(facts.find((row) => row.key === 'never-use').value, 'orders');
});

test('被压缩成 shadowed 的用户消息仍然抽出事实', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const ctx = { id: 'shadow-sess', cwd: 'D:\\proj' };
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1000,
      surfaceOp: 'append',
      data: { content: [{ type: 'text', text: '以后统一用 pnpm。' }] },
    },
    {
      seq: 2,
      type: 'assistant/message',
      time: 1100,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      data: { message: { content: [{ type: 'text', text: '已把 1 号事件折叠成摘要。' }] } },
    },
  ];

  const surfaces = computeSurfaces(events);
  assert.equal(surfaces.get(1), 'shadowed');
  assert.equal(surfaces.get(2), 'current');

  const result = ingestSession(db, { header: ctx, events });
  assert.equal(result.facts, 1);

  const fact = listFacts(db, { scope: 'D:\\proj' })[0];
  assert.ok(fact, 'shadowed 事件里的事实也应写入');
  assert.equal(fact.key, 'pkg-manager');
  assert.equal(fact.value, 'pnpm');
  assert.equal(fact.evidence_seq, 1);
  assert.equal(fact.status, 'active');
});

test('按事件类型截断文本，events.text 与 units 共享同一份截断文本', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const SUFFIX = '…[truncated]';
  const ctx = { id: 'trunc-sess', cwd: 'D:\\proj' };
  const longUser = '用'.repeat(7000);
  const longAssistant = 'A'.repeat(7000);
  const longToolResult = 'B'.repeat(3000);
  const toolCallText = `shell ${JSON.stringify({ payload: 'C'.repeat(3000) })}`;
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1,
      data: { content: [{ type: 'text', text: longUser }] },
    },
    {
      seq: 2,
      type: 'assistant/message',
      time: 2,
      data: { message: { content: [{ type: 'text', text: longAssistant }] } },
    },
    {
      seq: 3,
      type: 'tool/result',
      time: 3,
      data: { message: { content: [{ type: 'text', text: longToolResult }] } },
    },
    {
      seq: 4,
      type: 'tool/call',
      time: 4,
      data: { name: 'shell', arguments: { payload: 'C'.repeat(3000) } },
    },
  ];

  ingestSession(db, { header: ctx, events });

  const rows = db.prepare(
    'SELECT seq, text FROM events WHERE session_id = ? ORDER BY seq',
  ).all('trunc-sess');
  const bySeq = new Map(rows.map((row) => [row.seq, row.text]));

  assert.equal(bySeq.get(1).length, 7000, 'user/message 不截断');
  assert.equal(bySeq.get(2), longAssistant.slice(0, 6000) + SUFFIX, 'assistant 截到 6000');
  assert.equal(bySeq.get(3), longToolResult.slice(0, 2000) + SUFFIX, 'tool/result 截到 2000');
  assert.equal(bySeq.get(4), toolCallText.slice(0, 2000) + SUFFIX, 'tool/call 截到 2000');

  const units = db.prepare(
    'SELECT seq, start, end, text FROM units WHERE session_id = ? ORDER BY seq, start',
  ).all('trunc-sess');
  assert.ok(units.length > 4, '长事件应切成多个 unit');
  for (const unit of units) {
    assert.equal(
      bySeq.get(unit.seq).slice(unit.start, unit.end + 1),
      unit.text,
      'unit 偏移必须基于截断后的 events.text',
    );
  }
});

test('service.state 只列 typed facts，note 不上常驻状态表', async (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const ctx = { id: 'typed-only', cwd: 'D:\\proj' };
  const events = [
    {
      seq: 1,
      type: 'user/message',
      time: 1,
      data: { content: [{ type: 'text', text: '以后统一用 pnpm。' }] },
    },
    {
      // pkg-manager 槽位装不下 land -> 落成 note
      seq: 2,
      type: 'user/message',
      time: 2,
      data: { content: [{ type: 'text', text: '以后统一用 land 吧。' }] },
    },
  ];

  const result = extractFacts(db, { header: ctx, events });
  assert.equal(result.facts, 2);
  assert.equal(listFacts(db, { scope: 'D:\\proj' }).length, 2, 'listFacts 仍返回 note');

  const service = createService({ db, scope: 'D:\\proj' });
  const state = String(await service.state());
  assert.match(state, /pkg-manager/);
  assert.match(state, /pnpm/);
  assert.doesNotMatch(state, /land/, 'note 不应出现在常驻状态表');
  assert.match(state, /1 active facts/);

  const empty = String(await createService({ db, scope: 'D:\\none' }).state());
  assert.match(empty, /0 active facts/);
  assert.match(empty, /没有结构化约定/);
  assert.match(empty, /memory\(action="search"\)/);
});

test('子代理会话只入库 units，不抽事实', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const events = [{
    seq: 1,
    type: 'user/message',
    time: 1000,
    data: { content: [{ type: 'text', text: '以后统一用 pnpm。' }] },
  }];
  const subHeader = {
    id: 'sub-1',
    cwd: 'D:\\proj',
    delegationDepth: 1,
    origin: 'subagent',
  };

  assert.equal(extractFacts(db, { header: subHeader, events }).facts, 0);
  assert.equal(listFacts(db, { scope: 'D:\\proj' }).length, 0);

  // units 照常入库，检索仍可用
  const result = ingestSession(db, { header: subHeader, events });
  assert.ok(result.units > 0, '子代理会话的 units 仍要入库');
  assert.equal(result.facts, 0);
  assert.equal(listFacts(db, { scope: 'D:\\proj' }).length, 0);

  // 只有 delegationDepth > 0（origin 缺失）也不抽
  assert.equal(
    extractFacts(db, { header: { id: 'sub-2', cwd: 'D:\\proj', delegationDepth: 2 }, events }).facts,
    0,
  );
  // 只有 origin='subagent'（depth 缺失）也不抽
  assert.equal(
    extractFacts(db, { header: { id: 'sub-3', cwd: 'D:\\proj', origin: 'subagent' }, events }).facts,
    0,
  );
  // 根会话照常抽
  assert.equal(
    extractFacts(db, {
      header: { id: 'root-1', cwd: 'D:\\proj', delegationDepth: 0, origin: 'interactive' },
      events,
    }).facts,
    1,
  );
});

test('同 (key, value, scope, quote) 的证据只保留一条', (t) => {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });

  const text = '不要 markdown 围栏。';
  const makeEvents = (time) => [{
    seq: 1,
    type: 'user/message',
    time,
    data: { content: [{ type: 'text', text }] },
  }];
  const header = (id) => ({ id, cwd: 'D:\\proj', delegationDepth: 0 });

  assert.equal(extractFacts(db, { header: header('root-a'), events: makeEvents(2000) }).facts, 1);
  // 同 quote 再次入库：不新增，只刷新
  assert.equal(extractFacts(db, { header: header('root-b'), events: makeEvents(3000) }).facts, 0);

  const [fact] = listFacts(db, { scope: 'D:\\proj' });
  assert.equal(listFacts(db, { scope: 'D:\\proj' }).length, 1);
  assert.equal(fact.quote, '不要 markdown 围栏');
  assert.equal(fact.evidence_session, 'root-a');
  assert.equal(fact.evidence_seq, 1);
  assert.equal(fact.status, 'active');

  // 更早的证据出现：迁到更早的一条，仍然只有一行
  assert.equal(extractFacts(db, { header: header('root-c'), events: makeEvents(1000) }).facts, 0);
  const after = listFacts(db, { scope: 'D:\\proj' });
  assert.equal(after.length, 1);
  assert.equal(after[0].since, 1000);
  assert.equal(after[0].evidence_session, 'root-c');
  assert.equal(after[0].quote, '不要 markdown 围栏');
});
