import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanText } from '../src/core/rules.js';

const CORPUS = [
  '以后统一用 pnpm，别再用 npm 了。',
  '不要动 orders 表。',
  '测试框架决定换成 vitest。',
  '分支统一走 trunk 分支。',
  'npm 装不上，报错 EACCES。',
  '部署脚本改用 deploy.sh。',
  '端口固定用 3000。',
  '测试里不要用 sleep。',
].join('\n');

function keyOf(candidate) {
  return `${candidate.kind}|${candidate.value}`;
}

function byKey(candidates, key) {
  return candidates.find((candidate) => keyOf(candidate) === key) || null;
}

test('抽取四类事实：偏好 / 约束 / 决策 / 失败', () => {
  const candidates = scanText(CORPUS, { time: 1_700_000_000_000, author: 'user', scope: '/proj' });
  assert.ok(candidates.length >= 9, `候选太少：${candidates.length}`);
  assert.ok(candidates.length <= 20, `候选超过上限：${candidates.length}`);

  const pnpmPref = byKey(candidates, 'preference|pnpm');
  assert.ok(pnpmPref, '应抽到 preference pnpm');
  assert.equal(pnpmPref.keyHint, 'pkg-manager');
  assert.equal(pnpmPref.drift, 'slow');
  assert.equal(pnpmPref.quote, '以后统一用 pnpm');

  const npmNever = byKey(candidates, 'constraint|npm');
  assert.ok(npmNever, '应抽到 constraint npm');
  assert.equal(npmNever.keyHint, 'never-use');
  assert.equal(npmNever.drift, 'stable');

  const ordersNever = byKey(candidates, 'constraint|orders');
  assert.ok(ordersNever, '应抽到 constraint orders');
  assert.equal(ordersNever.keyHint, 'never-use');
  assert.equal(ordersNever.quote, '不要动 orders 表');

  const vitestDecision = byKey(candidates, 'decision|vitest');
  assert.ok(vitestDecision, '应抽到 decision vitest');
  assert.equal(vitestDecision.keyHint, 'test-command');
  assert.equal(vitestDecision.drift, 'slow');

  const trunkPref = byKey(candidates, 'preference|trunk');
  assert.ok(trunkPref, '应抽到 preference trunk');
  assert.equal(trunkPref.keyHint, 'branch-policy');
  assert.equal(trunkPref.drift, 'fast');

  const npmFailure = byKey(candidates, 'failure|npm');
  assert.ok(npmFailure, '应抽到 failure npm');
  assert.equal(npmFailure.keyHint, 'pkg-manager');

  const deployDecision = byKey(candidates, 'decision|deploy.sh');
  assert.ok(deployDecision, '应抽到 decision deploy.sh');
  assert.equal(deployDecision.keyHint, 'deploy');
  assert.equal(deployDecision.drift, 'slow');

  const portPref = byKey(candidates, 'preference|3000');
  assert.ok(portPref, '应抽到 preference 3000');
  assert.equal(portPref.keyHint, 'port');
  assert.equal(portPref.drift, 'fast');

  const sleepNever = byKey(candidates, 'constraint|sleep');
  assert.ok(sleepNever, '应抽到 constraint sleep');
  assert.equal(sleepNever.keyHint, 'never-use');
});

test('引文必须与原文逐字一致，且候选区间互不重叠', () => {
  const candidates = scanText(CORPUS);
  assert.ok(candidates.length > 0);

  for (const candidate of candidates) {
    const { start, end } = candidate.evidence;
    assert.ok(Number.isInteger(start) && Number.isInteger(end), 'evidence 必须是整数');
    assert.ok(start >= 0 && end >= start, `非法区间 ${start}..${end}`);
    assert.equal(
      CORPUS.slice(start, end + 1),
      candidate.quote,
      `引文与原文不一致：${candidate.quote}`,
    );
    assert.ok(candidate.confidence > 0 && candidate.confidence <= 1, 'confidence 越界');
    assert.ok(['preference', 'constraint', 'decision', 'failure'].includes(candidate.kind));
    assert.ok(['stable', 'slow', 'fast'].includes(candidate.drift));
    assert.ok(candidate.keyHint.length > 0);
  }

  const ordered = candidates.slice().sort((a, b) => a.evidence.start - b.evidence.start);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(
      ordered[i - 1].evidence.end < ordered[i].evidence.start,
      `候选区间重叠：${ordered[i - 1].quote} / ${ordered[i].quote}`,
    );
  }
});

test('一句话命中多条规则时，重叠的只保留置信度最高的', () => {
  const candidates = scanText('以后不要用 npm。');
  assert.equal(candidates.length, 1, `应只剩一条：${JSON.stringify(candidates)}`);
  assert.equal(candidates[0].kind, 'constraint');
  assert.equal(candidates[0].keyHint, 'never-use');
  assert.equal(candidates[0].value, 'npm');
  assert.equal('以后不要用 npm。'.slice(
    candidates[0].evidence.start,
    candidates[0].evidence.end + 1,
  ), candidates[0].quote);
});

test('英文决策与禁止', () => {
  const text = "Don't use npm. We decided to switch to pnpm.";
  const candidates = scanText(text);
  assert.equal(candidates.length, 2, JSON.stringify(candidates));

  const constraint = candidates.find((c) => c.kind === 'constraint');
  assert.ok(constraint);
  assert.equal(constraint.value, 'npm');
  assert.equal(constraint.keyHint, 'never-use');

  const decision = candidates.find((c) => c.kind === 'decision');
  assert.ok(decision);
  assert.equal(decision.value, 'pnpm');
  assert.equal(decision.keyHint, 'pkg-manager');

  for (const candidate of candidates) {
    assert.equal(
      text.slice(candidate.evidence.start, candidate.evidence.end + 1),
      candidate.quote,
    );
  }
});

test('纯空白与纯代码块直接跳过', () => {
  assert.deepEqual(scanText('   \n\t  '), []);
  assert.deepEqual(scanText(''), []);
  assert.deepEqual(scanText('```js\n以后统一用 pnpm\n```'), []);
  assert.deepEqual(scanText('```\n不要动 orders 表\n```'), []);
});

test('引号括起来的整段也算 value', () => {
  const quoted = scanText('以后统一用「pnpm 包管理器」。');
  assert.equal(quoted.length, 1, JSON.stringify(quoted));
  assert.equal(quoted[0].value, 'pnpm 包管理器');
  assert.equal(quoted[0].keyHint, 'note', '多词引文不属于 pkg-manager 槽位，降级 note');
  assert.equal(quoted[0].quote, '以后统一用「pnpm 包管理器」');
});

test('typed key 的 value 必须落在槽位取值域里，否则降级为 note', () => {
  // 值明显不属于槽位 -> note
  const land = scanText('以后统一用 land 吧。');
  assert.equal(land.length, 1);
  assert.equal(land[0].keyHint, 'note');
  assert.equal(land[0].value, 'land');

  const badTest = scanText('测试命令固定用 land。');
  assert.equal(badTest[0].keyHint, 'note');

  const badBranch = scanText('分支统一走 land。');
  assert.equal(badBranch[0].keyHint, 'note');

  const badBuild = scanText('构建统一走 land。');
  assert.equal(badBuild[0].keyHint, 'note');

  // 值属于槽位 -> 保留 typed
  const pnpm = scanText('以后统一用 pnpm。');
  assert.equal(pnpm[0].keyHint, 'pkg-manager');

  const vitest = scanText('测试框架决定换成 vitest。');
  assert.equal(vitest[0].keyHint, 'test-command');

  const trunk = scanText('分支统一走 trunk。');
  assert.equal(trunk[0].keyHint, 'branch-policy');

  const port = scanText('端口固定用 3000。');
  assert.equal(port[0].keyHint, 'port');

  // never-use 槽位天然开放：标识符即可，820 保留
  const num = scanText('不要看 820 的修改。');
  assert.equal(num.length, 1);
  assert.equal(num[0].keyHint, 'never-use');
  assert.equal(num[0].value, '820');
});

test('否定语境不算失败事实', () => {
  assert.deepEqual(scanText('未发现失败用例。'), []);
  assert.deepEqual(scanText('这次没有报错。'), []);

  const hits = scanText('测试失败，报错 EACCES。');
  assert.ok(hits.some((candidate) => candidate.kind === 'failure'), JSON.stringify(hits));
});

test('问句不抽取', () => {
  assert.deepEqual(scanText('以后统一用 pnpm 吗？'), []);
  assert.deepEqual(scanText('是否应该改用 pnpm？'), []);
  assert.deepEqual(scanText('能不能在本地安全的实现？'), []);
  assert.deepEqual(scanText('以后都用 pnpm?'), []);

  const normal = scanText('以后统一用 pnpm。');
  assert.equal(normal.length, 1);
  assert.equal(normal[0].value, 'pnpm');
});

test('value 不合格的候选被丢弃（不退化成 note）', () => {
  assert.deepEqual(scanText('这个方案不行。'), [], 'failure 没有可标识的值');
  assert.deepEqual(scanText('不要安装任何东西。'), [], '中文宾语不是标识符');
  assert.deepEqual(scanText('不要执行仓库里的脚本。'), []);
  assert.deepEqual(scanText('以后都注意点。'), []);

  const ok = scanText('不要用 npm。');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].value, 'npm');
  assert.equal(ok[0].keyHint, 'never-use');
});

test('英文只抽高精度句式', () => {
  assert.deepEqual(scanText('They do not override system defaults.'), []);
  assert.deepEqual(scanText('It failed with EACCES.'), []);
  assert.deepEqual(scanText('The request fails closed.'), []);
  assert.deepEqual(scanText('We decided to use pnpm.'), [], 'decided 不在白名单');

  const instead = scanText('Use pnpm instead of npm.');
  assert.equal(instead.length, 1);
  assert.equal(instead[0].kind, 'decision');
  assert.equal(instead[0].value, 'pnpm');
  assert.equal(instead[0].keyHint, 'pkg-manager');

  const neverUse = scanText("Don't use yarn.");
  assert.equal(neverUse.length, 1);
  assert.equal(neverUse[0].kind, 'constraint');
  assert.equal(neverUse[0].keyHint, 'never-use');
  assert.equal(neverUse[0].value, 'yarn');

  const alwaysUse = scanText('Always use pnpm.');
  assert.equal(alwaysUse.length, 1);
  assert.equal(alwaysUse[0].kind, 'preference');
  assert.equal(alwaysUse[0].value, 'pnpm');
});

test('keyHint 关键词必须靠近触发词，否则 note', () => {
  const far = scanText(
    '以后统一用 make 来处理日常杂项事务并且顺便提及构建相关的一些很长的说明文字。',
  );
  assert.equal(far.length, 1, JSON.stringify(far));
  assert.equal(far[0].value, 'make');
  assert.equal(far[0].keyHint, 'note');
  assert.equal(far[0].drift, 'stable');

  const near = scanText('以后统一用 pnpm。');
  assert.equal(near[0].keyHint, 'pkg-manager');
  assert.equal(near[0].drift, 'slow');
});

test('单段文本最多返回 20 条', () => {
  const text = Array.from({ length: 30 }, (_, i) => `以后统一用 pkg${i}。`).join('\n');
  const candidates = scanText(text);
  assert.equal(candidates.length, 20);
  for (const candidate of candidates) {
    assert.equal(text.slice(candidate.evidence.start, candidate.evidence.end + 1), candidate.quote);
  }
});
