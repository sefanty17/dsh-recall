// 纯数据：memory 工具的名字 / 描述 / 参数 schema。
// 不 import 任何 DSH 包，本地 node --test 可以直接跑。

export const MEMORY_TOOL_NAME = 'memory';

// ≤120 字，只列 action，不写教程。
export const MEMORY_TOOL_DESCRIPTION =
  '项目记忆。state：当前有效约定；history：某键的演变；search：检索带原文出处的结论；read：读某条事件原文；write：记录新约定。';

// DSH 简化 schema：{ field: { type, required, description, enum?, items? } }
// 不是标准 JSON Schema。
export const MEMORY_TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['state', 'history', 'search', 'read', 'write'],
    description:
      'state=看当前有效约定；history=某个键怎么变的；search=按关键词找原文证据；read=看某条事件全文；write=记录新约定',
  },
  query: {
    type: 'string',
    description: 'search 用：原文里的关键词，中文直接写整句',
  },
  key: {
    type: 'string',
    description: 'history 用：键名，如 pkg-manager',
  },
  content: {
    type: 'string',
    description: 'write 用：要记的结论，可写「键=值 + 依据」',
  },
  scope: {
    type: 'string',
    description: '限定项目路径，默认当前会话的工作目录',
  },
  limit: {
    type: 'number',
    description: 'search 返回条数，默认 8',
  },
  session_id: {
    type: 'string',
    description: 'read 用：会话 id（search/state 结果里有）',
  },
  seq: {
    type: 'number',
    description: 'read 用：事件序号',
  },
};
