import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatHit,
  formatState,
  formatSearchResult,
  formatHistory,
  displayWidth,
  padRight,
  truncate,
  fitWidth,
  formatDay,
  formatTime,
  shortId,
} from '../src/core/format.js';

const CWD = 'D:\\personal_vibe\\dsh-recall';
const SID = '019c6e8f-aaaa-7bbb-8ccc-000000000001';

// 用本地时间构造，保证断言不依赖时区。
const T1 = new Date(2026, 2, 2, 9, 5).getTime(); // 2026-03-02 09:05
const T2 = new Date(2026, 2, 5, 10, 20).getTime(); // 2026-03-05 10:20
const T3 = new Date(2026, 2, 6, 18, 0).getTime(); // 2026-03-06 18:00

// ---------------------------------------------------------------------------
// 基础格式化工具
// ---------------------------------------------------------------------------

test('时间统一 YYYY-MM-DD HH:mm，中文按 2 字符宽', () => {
  assert.equal(formatDay(T2), '2026-03-05');
  assert.equal(formatTime(T2), '2026-03-05 10:20');
  assert.equal(formatTime(T1), '2026-03-02 09:05');
  assert.equal(formatTime(null), '????-??-?? ??:??');

  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('包管理器'), 8);
  assert.equal(displayWidth('❌never-use'), 11); // emoji 也算 2
  assert.equal(padRight('中文', 6), '中文  ');
  assert.equal(padRight('abcdef', 3), 'abcdef');
});

test('引文超过 60 字截断加 …，并压成单行', () => {
  const long = '啊'.repeat(80);
  assert.equal(truncate(long), `${'啊'.repeat(60)}…`);
  assert.equal(truncate('短\n多行  文本'), '短 多行 文本');
  assert.equal(shortId(SID), '019c6e8f-aaaa-7bbb…'); // 前 18 位
  assert.equal(shortId('abc'), 'abc');
});

test('fitWidth：按显示宽度截断，列宽不被中文撑破', () => {
  assert.equal(fitWidth('abc', 10), 'abc');
  const wide = fitWidth('中文'.repeat(20), 10);
  assert.ok(displayWidth(wide) <= 10, `实际宽度 ${displayWidth(wide)} 超过了 10`);
  assert.ok(wide.endsWith('…'));
  assert.equal(displayWidth(fitWidth('abcdefghij', 5)), 5);
});

// ---------------------------------------------------------------------------
// formatState
// ---------------------------------------------------------------------------

const STATE_FACTS = [
  {
    key: 'test-command',
    value: 'node --test',
    scope: CWD,
    kind: 'decision',
    status: 'active',
    since: T1,
    author: 'user',
    verified: 1,
    evidence_seq: 17,
  },
  {
    key: 'never-use',
    value: 'npm',
    scope: CWD,
    kind: 'constraint',
    status: 'active',
    since: T2,
    author: 'user',
    verified: 1,
    evidence_seq: 38,
  },
  {
    key: 'pkg-manager',
    value: 'pnpm',
    scope: CWD,
    kind: 'decision',
    status: 'active',
    since: T3,
    author: 'user',
    verified: 1,
    evidence_seq: 42,
  },
  {
    key: 'pkg-manager',
    value: 'npm',
    scope: CWD,
    kind: 'decision',
    status: 'superseded',
    since: T1,
    author: 'user',
    evidence_seq: 12,
  },
];

test('formatState：开头标记 + 计数 + 关键字段 + history 提示', () => {
  const out = formatState(STATE_FACTS, { scope: CWD });
  const [header] = out.split('\n');

  assert.ok(out.startsWith('[memory.state]'), '必须以 [memory.state] 开头');
  assert.equal(header, `[memory.state] scope=${CWD} · 3 active facts`);
  assert.ok(!out.includes('superseded'), '默认只列 active 事实');

  assert.match(out, /pkg-manager\s+= pnpm/);
  assert.match(out, /test-command\s+= node --test/);
  assert.ok(out.includes('2026-03-06'), '应包含 since 日期');
  assert.ok(out.includes('user'));
  assert.ok(out.includes('e42'), '应包含证据事件号');

  assert.match(out, /❌never-use/);
  assert.ok(out.includes('→ 看某个键的演变：memory(action="history", key="never-use")'));
});

test('formatState：宽字段对齐（中文算 2 格）', () => {
  const facts = [
    { key: '中文键', value: 'v1', status: 'active', since: T1, author: 'user', evidence_seq: 1 },
    { key: 'abc', value: 'v2', status: 'active', since: T1, author: 'user', evidence_seq: 2 },
    // 超长中文值必须被按显示宽度截断，不能把后面的日期列顶歪
    {
      key: 'long-value-key',
      value: '很长很长的中文值用来验证列宽'.repeat(4),
      status: 'active',
      since: T1,
      author: 'user',
      evidence_seq: 3,
    },
  ];
  const rows = formatState(facts, { scope: 's' })
    .split('\n')
    .filter((line) => line.includes(' = '));
  assert.equal(rows.length, 3);
  // 对齐要看显示宽度，不能看码元下标（中文占 1 个码元但 2 列）。
  const eqColumns = rows.map((line) => displayWidth(line.slice(0, line.indexOf('='))));
  assert.equal(new Set(eqColumns).size, 1, '等号必须在同一列');

  const dateColumns = rows.map((line) => {
    const at = line.search(/\d{4}-\d{2}-\d{2}/);
    return displayWidth(line.slice(0, at));
  });
  assert.equal(new Set(dateColumns).size, 1, '日期必须在同一列');
});

test('formatState：空列表不强行给 → 提示', () => {
  const out = formatState([], { scope: 'D:\\empty' });
  assert.ok(out.startsWith('[memory.state] scope=D:\\empty · 0 active facts'));
  assert.ok(!out.includes('→'));
});

// ---------------------------------------------------------------------------
// formatHit / formatSearchResult
// ---------------------------------------------------------------------------

const HIT = {
  unit: { session_id: SID, seq: 31, start: 120, end: 186, text: 'npm 装不上，lockfile 跟 CI 冲突', time: T2, author: 'user' },
  event: { session_id: SID, seq: 31, type: 'user/message', author: 'user', text: 'npm 装不上，lockfile 跟 CI 冲突' },
  session: { id: SID, cwd: CWD },
  fact: {
    key: 'pkg-manager',
    kind: 'failure',
    status: 'active',
    author: 'user',
    since: T2,
    quote: 'npm 装不上，lockfile 跟 CI 冲突',
    evidence_seq: 31,
  },
  score: 0.82,
  reasons: ['bm25=0.70', 'age=1d'],
  neighbors: [{ seq: 30, direction: 'before', text: '在跑 npm ci', author: 'assistant' }],
};

test('formatHit：自足单元包含 kind / 时间 / 作者 / 引文 / 来源 / 上下文', () => {
  const out = formatHit(HIT, { index: 0 });
  const lines = out.split('\n');

  assert.equal(lines[0], '1. [failure] 2026-03-05 10:20 · user');
  assert.equal(lines[1], '   "npm 装不上，lockfile 跟 CI 冲突"');
  assert.ok(out.includes('↳ session 019c6e8f-aaaa-7bbb… seq 31 [120,186]'));
  assert.ok(out.includes('↳ 前一条：在跑 npm ci'));
});

test('formatHit：上下文用带方向的短标签，每条 60 字以内', () => {
  const longText = '好问题，这里有个常见误解：'.repeat(10);
  const out = formatHit(
    {
      ...HIT,
      neighbors: [
        { seq: 30, direction: 'before', text: longText },
        { seq: 32, direction: 'after', text: '这是后一条' },
      ],
    },
    { index: 0 },
  );
  const lines = out.split('\n');
  const before = lines.find((l) => l.includes('前一条'));
  const after = lines.find((l) => l.includes('后一条'));

  assert.ok(before?.startsWith('   ↳ 前一条：'), '前一条要用行内短标签');
  assert.ok(after?.startsWith('   ↳ 后一条：'), '后一条要用行内短标签');
  assert.ok(!out.includes('↳ 上下文：'), '不再使用旧的「↳ 上下文：」前缀');
  assert.ok(before.includes('好问题，这里有个常见误解'), '应保留开头的可读内容');
  const snippet = before.replace('   ↳ 前一条：', '');
  assert.ok([...snippet].length <= 61, `上下文过长：${[...snippet].length}`);
});

test('formatHit：长 session id 行内显示前 18 位，可辨识', () => {
  const uuid = 'ed3e1da7-a088-44cb-9037-671aa5174833';
  const prefixed = 'session-a3b6757f-744a-45dd-8610-f8d00b576415';

  const a = formatHit({ ...HIT, session: { ...HIT.session, id: uuid } }, { index: 0 });
  assert.ok(a.includes(`↳ session ${uuid.slice(0, 18)}… seq 31`), a);
  assert.ok(!a.includes('sessio…'), '不能退化成 sessio…');

  const b = formatHit({ ...HIT, session: { ...HIT.session, id: prefixed } }, { index: 0 });
  assert.ok(b.includes(`↳ session ${prefixed.slice(0, 18)}… seq 31`), b);
  assert.ok(b.includes('session-a3b6757f-'), '带 session- 前缀的 id 要能辨认');
});

test('formatSearchResult：提示行给完整 session id（可直接拿去调工具）', () => {
  const uuid = 'ed3e1da7-a088-44cb-9037-671aa5174833';
  const out = formatSearchResult(
    [{ ...HIT, session: { ...HIT.session, id: uuid }, unit: { ...HIT.unit, seq: 73 } }],
    { scope: CWD },
  );
  const hint = out.split('\n').find((l) => l.startsWith('→ 完整上下文：'));
  assert.ok(hint, '必须有完整上下文提示');
  assert.equal(
    hint,
    `→ 完整上下文：session_event_read(session_id="${uuid}", seq=73)`,
  );
});

test('formatHit：不传 index 时不加序号，且引文超长截断', () => {
  const long = '啊'.repeat(80);
  const out = formatHit({ ...HIT, fact: { ...HIT.fact, quote: long } });
  assert.ok(!out.startsWith('1. '));
  assert.ok(out.includes(`"${'啊'.repeat(60)}…"`));
  assert.ok(!out.includes('啊'.repeat(61)));
  assert.ok(out.includes('↳ session 019c6e8f-aaaa-7bbb… seq 31'));
});

test('formatSearchResult：开头标记 + 计数 + 模式 + 编号 + 下一步提示', () => {
  const out = formatSearchResult([HIT], { scope: CWD });
  const lines = out.split('\n');

  assert.equal(lines[0], `[memory.search] 1 hit · scope=${CWD} · active only`);
  assert.ok(out.includes('1. [failure] 2026-03-05 10:20 · user'));
  assert.ok(out.includes('↳ session 019c6e8f-aaaa-7bbb… seq 31 [120,186]'));
  assert.ok(
    out.includes(`→ 完整上下文：session_event_read(session_id="${SID}", seq=31)`),
    '有 session/seq 时必须给出可执行的下一步',
  );
  assert.ok(!out.includes('memory(action="history"'), '没有废弃事实时不给 history 提示');
});

test('formatSearchResult：多命中编号递增，hits 复数正确', () => {
  const out = formatSearchResult([HIT, { ...HIT, unit: { ...HIT.unit, seq: 32 }, fact: null }], {
    scope: CWD,
    includeSuperseded: true,
  });
  assert.ok(out.startsWith(`[memory.search] 2 hits · scope=${CWD} · incl. superseded`));
  assert.ok(out.includes('1. [failure]'));
  assert.ok(out.includes('2. [evidence]'), '无 fact 的命中标成 evidence');
});

test('formatSearchResult：0 命中不强行给 → 提示', () => {
  const out = formatSearchResult([], { scope: CWD });
  assert.ok(out.startsWith(`[memory.search] 0 hits · scope=${CWD} · active only`));
  assert.ok(!out.includes('→'));
});

test('formatSearchResult：命中已废弃事实时提示 history', () => {
  const stale = { ...HIT, fact: { ...HIT.fact, status: 'superseded' } };
  const out = formatSearchResult([stale], { scope: CWD, includeSuperseded: true });
  assert.ok(out.includes('· superseded'));
  assert.ok(out.includes('→ 已废弃版本：memory(action="history", key="pkg-manager")'));
});

// ---------------------------------------------------------------------------
// formatHistory
// ---------------------------------------------------------------------------

const HISTORY_FACTS = [
  {
    key: 'pkg-manager',
    value: 'npm',
    quote: '这个项目用 npm 就行',
    status: 'superseded',
    author: 'user',
    since: T1,
    evidence_seq: 12,
    scope: CWD,
  },
  {
    key: 'pkg-manager',
    value: 'pnpm',
    quote: 'CI 只认 pnpm-lock',
    status: 'active',
    author: 'user',
    since: T3,
    evidence_seq: 42,
    scope: CWD,
  },
];

test('formatHistory：开头标记 + 版本数 + ACTIVE + superseded', () => {
  const out = formatHistory(HISTORY_FACTS, { key: 'pkg-manager' });
  const lines = out.split('\n');

  assert.equal(lines[0], '[memory.history] pkg-manager · 2 versions');
  assert.ok(out.startsWith('[memory.history]'));
  assert.match(out, /^2026-03-02 {2}npm {2,}"这个项目用 npm 就行" {2,}e12 {2}superseded$/m);
  assert.match(out, /^2026-03-06 {2}pnpm {2,}"CI 只认 pnpm-lock" {2,}e42 {2}ACTIVE$/m);
  assert.ok(out.includes('→ 当前生效：pnpm'), '应指出当前生效版本');
});

test('formatHistory：缺 quote/evidence 时不留裸 - -', () => {
  const facts = [
    { key: 'pkg-manager', value: 'pnpm', status: 'active', since: T2, author: 'agent' },
    { key: 'pkg-manager', value: 'npm', status: 'superseded', since: T1, author: 'agent' },
  ];
  const out = formatHistory(facts, { key: 'pkg-manager' });

  assert.ok(!out.includes('-  -'), out);
  assert.ok(!/-\s{2,}-/.test(out), `不能出现连续两个空列：${out}`);
  assert.ok(out.includes('ACTIVE'));
  assert.ok(!out.includes('—'), '整列都没有值时应直接省略该列');
});

test('formatHistory：部分行缺 evidence 时用 — 占位，不出现裸 -', () => {
  const out = formatHistory(
    [
      { key: 'k', value: 'v1', status: 'active', since: T2, author: 'user', evidence_seq: 42 },
      { key: 'k', value: 'v2', status: 'superseded', since: T1, author: 'agent' },
    ],
    { key: 'k' },
  );
  assert.ok(out.includes('e42'));
  assert.ok(out.includes('—'), '缺值行用 — 占位');
  assert.ok(!/-\s{2,}-/.test(out), `不能出现连续两个空列：${out}`);
  assert.ok(!out.includes(' - '), `不能有裸 - 单元格：${out}`);
});

test('formatHistory：0 版本不炸也不给 →', () => {
  const out = formatHistory([], { key: 'unknown' });
  assert.ok(out.startsWith('[memory.history] unknown · 0 versions'));
  assert.ok(!out.includes('→'));
});

test('formatHistory：全部废弃时提示没有生效版本', () => {
  const out = formatHistory([{ ...HISTORY_FACTS[0] }], { key: 'pkg-manager' });
  assert.ok(out.startsWith('[memory.history] pkg-manager · 1 version'));
  assert.ok(out.includes('→ 当前无生效版本'), out);
});

test('formatHistory：多值键结尾按 active 条数分支，不谎报单一生效', () => {
  const many = [
    { key: 'never-use', value: 'dead_code', status: 'active', since: T1, author: 'user', evidence_seq: 7 },
    { key: 'never-use', value: 'unused_var', status: 'active', since: T2, author: 'user', evidence_seq: 8 },
    { key: 'never-use', value: 'print', status: 'active', since: T3, author: 'user', evidence_seq: 9 },
  ];
  const out = formatHistory(many, { key: 'never-use' });

  assert.ok(out.includes('→ 3 条同时有效（约束可以叠加）'), out);
  assert.ok(!out.includes('→ 当前生效：'), '多值键不能谎报只有一个生效');
  assert.equal(out.split('\n').filter((l) => l.endsWith('ACTIVE')).length, 3);

  // 单值键保持原提示
  const single = formatHistory([{ ...HISTORY_FACTS[1] }], { key: 'pkg-manager' });
  assert.ok(single.includes('→ 当前生效：pnpm（2026-03-06，e42）'), single);
});
