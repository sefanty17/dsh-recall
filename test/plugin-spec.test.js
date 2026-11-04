import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_PARAMETERS,
} from '../src/plugin/tool-spec.js';
import { DIVISION_OF_LABOR, buildMemoryContext } from '../src/plugin/prompt.js';

const ACTIONS = ['state', 'history', 'search', 'read', 'write'];

const DIVISION_QUERY = '问「现在是什么 / 当时为什么 / 有没有改过」用 memory 工具';
const DIVISION_WRITE = '用 memory(action="write") 记一条';

function cjkCount(text) {
  return (String(text).match(/[\u3400-\u9fff]/g) ?? []).length;
}

function fact(index, overrides = {}) {
  return {
    id: `f${index}`,
    key: `key-${index}`,
    value: `value-${index}`,
    status: 'active',
    since: Date.UTC(2026, 0, 1 + (index % 27)),
    author: 'user',
    ...overrides,
  };
}

test('tool-spec：名字与描述', () => {
  assert.equal(MEMORY_TOOL_NAME, 'memory');
  assert.ok(MEMORY_TOOL_DESCRIPTION.length > 0);
  assert.ok([...MEMORY_TOOL_DESCRIPTION].length <= 120, `描述 ${MEMORY_TOOL_DESCRIPTION.length} 字，超过 120`);
  for (const action of ['state', 'history', 'search', 'write']) {
    assert.ok(MEMORY_TOOL_DESCRIPTION.includes(action), `描述缺少 action: ${action}`);
  }
});

test('tool-spec：action 参数契约完整', () => {
  const action = MEMORY_TOOL_PARAMETERS.action;
  assert.equal(action.type, 'string');
  assert.equal(action.required, true);
  assert.deepEqual(action.enum, ACTIONS);
  assert.ok(action.description.length > 0);

  // 四个必选 action + 可选 read 的参数都在
  for (const field of ['query', 'key', 'content', 'scope', 'session_id']) {
    assert.equal(MEMORY_TOOL_PARAMETERS[field]?.type, 'string', `${field} 应为 string`);
  }
  assert.equal(MEMORY_TOOL_PARAMETERS.limit.type, 'number');
  assert.equal(MEMORY_TOOL_PARAMETERS.seq.type, 'number');
});

test('buildMemoryContext：0 条事实', () => {
  const text = buildMemoryContext({ facts: [], scope: 'D:\\personal_vibe\\dsh-recall' });
  const lines = text.split('\n');
  assert.ok(lines.length <= 40);
  assert.equal(lines.length, 5);
  assert.match(text, /## 项目记忆/);
  assert.match(text, /scope: D:\\personal_vibe\\dsh-recall/);
  assert.match(text, /暂无记忆/);
  assert.match(text, /memory\(action="write"\)/);
  assert.ok(text.includes(DIVISION_OF_LABOR));
  assert.ok(text.includes(DIVISION_QUERY));
  assert.ok(text.includes(DIVISION_WRITE));
});

test('prompt：分工两句都在且 ≤80 中文字', () => {
  assert.ok(DIVISION_OF_LABOR.includes(DIVISION_QUERY));
  assert.ok(DIVISION_OF_LABOR.includes(DIVISION_WRITE));
  assert.equal(DIVISION_OF_LABOR.split('\n').length, 2);
  assert.ok(cjkCount(DIVISION_OF_LABOR) <= 80, `分工 ${cjkCount(DIVISION_OF_LABOR)} 中文字`);
});

test('buildMemoryContext：3 条事实完整展示', () => {
  const facts = [
    fact(0, { key: 'pkg-manager', value: 'pnpm', since: Date.UTC(2026, 2, 6) }),
    fact(1, { key: 'test-command', value: 'pytest', since: Date.UTC(2026, 1, 11) }),
    fact(2, { key: 'never-use', value: 'npm', since: Date.UTC(2026, 2, 5), status: 'superseded' }),
  ];
  const text = buildMemoryContext({ facts, scope: 'D:\\personal_vibe\\dsh-recall' });
  const lines = text.split('\n');
  assert.equal(lines.length, 7);
  assert.match(text, /pkg-manager\s+= pnpm\s+\(2026-03-06, user\)/);
  assert.match(text, /test-command\s+= pytest\s+\(2026-02-11, user\)/);
  assert.match(text, /never-use\s+= npm/);
  assert.match(text, /superseded/);
  assert.doesNotMatch(text, /省略/);
  assert.ok(text.includes(DIVISION_OF_LABOR));
});

test('buildMemoryContext：60 条事实截断且总行数 ≤40', () => {
  const facts = Array.from({ length: 60 }, (_, i) => fact(i));
  const text = buildMemoryContext({ facts, scope: 'D:\\personal_vibe\\dsh-recall' });
  const lines = text.split('\n');
  assert.ok(lines.length <= 40, `实际 ${lines.length} 行`);
  assert.match(text, /省略 25 条/);
  assert.match(text, /memory\(action="state"\)/);
  assert.ok(text.includes(DIVISION_OF_LABOR));
});

test('buildMemoryContext：maxFacts 生效', () => {
  const facts = Array.from({ length: 10 }, (_, i) => fact(i));
  const text = buildMemoryContext({ facts, scope: 'global', maxFacts: 5 });
  const lines = text.split('\n');
  assert.ok(lines.length <= 40);
  assert.match(text, /省略 5 条/);
  // 展示前 5 条，第 6 条起被截断
  assert.match(text, /key-4/);
  assert.doesNotMatch(text, /key-5\s+=/);
});

test('buildMemoryContext：没有 value 时回退到 quote', () => {
  const text = buildMemoryContext({
    facts: [{ key: 'pkg-manager', quote: '以后统一用 pnpm', since: Date.UTC(2026, 2, 6), author: 'user' }],
    scope: 'global',
  });
  assert.match(text, /pkg-manager\s+= 以后统一用 pnpm/);
});

test('buildMemoryContext：空 scope 回退 global', () => {
  const text = buildMemoryContext({ facts: [fact(0)], scope: '' });
  assert.match(text, /scope: global/);
});
