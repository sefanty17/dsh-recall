import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_INSTRUCTION,
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_PARAMETERS,
} from '../src/plugin/tool-spec.js';

const ACTIONS = ['search', 'recall', 'read', 'trace'];

test('tool-spec：名字与描述', () => {
  assert.equal(MEMORY_TOOL_NAME, 'memory');
  assert.ok(MEMORY_TOOL_DESCRIPTION.length > 0);
  assert.ok([...MEMORY_TOOL_DESCRIPTION].length <= 120, `描述 ${MEMORY_TOOL_DESCRIPTION.length} 字，超过 120`);
  for (const action of ACTIONS) {
    assert.ok(MEMORY_TOOL_DESCRIPTION.includes(action), `描述缺少 action: ${action}`);
  }
});

test('tool-spec：只有四个 action，且参数契约完整', () => {
  const action = MEMORY_TOOL_PARAMETERS.action;
  assert.equal(action.type, 'string');
  assert.equal(action.required, true);
  assert.deepEqual(action.enum, ACTIONS);
  assert.ok(action.description.length > 0);
  for (const name of ACTIONS) {
    assert.ok(action.description.includes(name), `action 描述缺少 ${name}`);
  }
});

test('tool-spec：可选参数与 v1 参数清理', () => {
  for (const field of ['query', 'question', 'scope', 'session_id']) {
    assert.equal(MEMORY_TOOL_PARAMETERS[field]?.type, 'string', `${field} 应为 string`);
  }
  assert.equal(MEMORY_TOOL_PARAMETERS.limit.type, 'number');
  assert.equal(MEMORY_TOOL_PARAMETERS.seq.type, 'number');
  // state / history / write 已删除，不再有 key / content
  assert.equal(MEMORY_TOOL_PARAMETERS.key, undefined);
  assert.equal(MEMORY_TOOL_PARAMETERS.content, undefined);
  // 参数说明要能指回 action
  assert.match(MEMORY_TOOL_PARAMETERS.question.description, /recall/);
  assert.match(MEMORY_TOOL_PARAMETERS.session_id.description, /read/);
  assert.match(MEMORY_TOOL_PARAMETERS.session_id.description, /trace/);
  assert.match(MEMORY_TOOL_PARAMETERS.seq.description, /read/);
});

test('常驻指令：静态提示覆盖 recall / read / trace', () => {
  assert.match(MEMORY_INSTRUCTION, /## 项目记忆（dsh-recall）/);
  assert.match(MEMORY_INSTRUCTION, /memory\(action="recall", question=\.\.\.\)/);
  assert.match(MEMORY_INSTRUCTION, /memory\(action="read"\/"trace"\)/);
  assert.match(MEMORY_INSTRUCTION, /span/);
  assert.match(MEMORY_INSTRUCTION, /主题/);
  // 是静态短指令，不是状态表
  assert.ok(MEMORY_INSTRUCTION.split('\n').length <= 5);
  assert.doesNotMatch(MEMORY_INSTRUCTION, /state|history|write/);
});

test('tool-spec：描述与指令里不再出现 v1 action', () => {
  const text = `${MEMORY_TOOL_DESCRIPTION}\n${MEMORY_INSTRUCTION}\n${MEMORY_TOOL_PARAMETERS.action.description}`;
  assert.doesNotMatch(text, /memory\(action="state"\)/);
  assert.doesNotMatch(text, /memory\(action="history"\)/);
  assert.doesNotMatch(text, /memory\(action="write"\)/);
});
