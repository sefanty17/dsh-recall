// 纯数据：memory 工具的名字 / 描述 / 参数 schema / 常驻静态指令。
// 不 import 任何 DSH 包，本地 node --test 可以直接跑。

export const MEMORY_TOOL_NAME = 'memory';

// ≤120 字，只列 action，不写教程。
export const MEMORY_TOOL_DESCRIPTION =
  '项目记忆。search：检索历史 span；recall：按问题召回主题并挑选 span；read：读事件原文（优先原生）；trace：查会话血缘。';

// DSH 简化 schema：{ field: { type, required, description, enum?, items? } }
// 不是标准 JSON Schema。
export const MEMORY_TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['search', 'recall', 'read', 'trace'],
    description:
      'search=按关键词找 span 概括；recall=按问题召回主题并选 span；read=读某条事件原始 JSON；trace=看会话血缘',
  },
  query: {
    type: 'string',
    description: 'search 用：关键词或整句，中文直接写',
  },
  question: {
    type: 'string',
    description: 'recall 用：要回答的问题（自然语言），用于主题召回 + 选择器',
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
    description: 'read / trace 用：会话 id；trace 不填为当前会话',
  },
  seq: {
    type: 'number',
    description: 'read 用：事件序号（search 结果里有）',
  },
};

// 代替 v1 状态表的常驻指令：告诉模型什么时候该主动用 memory。
export const MEMORY_INSTRUCTION = `## 项目记忆（dsh-recall）
这个项目有历史整理好的主题与 span。问「现在是什么 / 当时为什么 / 以前做过没有」时，
先用 memory(action="recall", question=...)，它会返回相关 span 的概括和轮次索引；
需要原话、思考链或会话血缘时，用 memory(action="read"/"trace")。`;
