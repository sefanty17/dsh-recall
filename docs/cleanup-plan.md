# 代码删减计划（v3 = 最终形态）

## 判断依据

最终需求只有一条链路：

```
会话文件 → span（决策/操作/叙述）→ topic（主题 md）
问题 → 主题阈值召回 → 选择器（开主题、选 span）→ 注入概括 + 轮次索引
模型主动：span 搜索 / 原生会话搜索（读原文、血缘）
```

由此反推：**facts（键值状态表）和 unit（原始切片检索）这两套是 v1 的过渡产物，最终形态不需要。**

## 保留（运行时）

| 文件 | 职责 |
|---|---|
| `src/core/reader.js` | zstd 多帧解码、会话文件扫描 |
| `src/core/chunk.js` | 中文按字切分、FTS phrase、span 检索用 |
| `src/core/db.js` | 只保留 spans / span_fts / span_vectors / topics / topic_vectors / curations |
| `src/core/spans.js` | span 存取 + 检索 |
| `src/core/topics.js` | 主题 md + git 保护 |
| `src/core/vectors.js` | embedding 抽象与向量存取 |
| `src/core/curator.js` | span 抽取 + 主题归组 |
| `src/core/selector.js` | 两阶段选择器 |
| `src/core/llm.js` | 模型调用 |
| `src/plugin/inject.js` | 同步/异步注入 |
| `src/plugin/index.js` | 工具 + waterfall 注入 + 后台整理调度 |
| `src/plugin/tool-spec.js` | 工具契约 |

## 删除

| 文件 | 原因 |
|---|---|
| `src/core/rules.js` | 规则抽取被 L2/curator 取代 |
| `src/core/facts.js` | 键值状态表被 span（decision）取代 |
| `src/core/extract.js` | L2 fact 抽取被 curator 取代 |
| `src/core/ingest.js` | 不再建 events/units/facts；curator 直接读会话文件 |
| `src/core/service.js` | memory 的 fact/unit 门面，随上四者删除 |
| `src/core/search.js` | unit 检索被 span 检索取代 |
| `src/core/format.js` | 只服务 fact/unit 输出 |
| `src/core/prompt.js` | 状态表注入被 span 注入取代 |
| `src/plugin/ingest-worker.js` | 不再有入库队列 |
| `scripts/extract.mjs` | 随 extract.js |
| `scripts/gen-queries.mjs` | 依赖 facts |
| `scripts/dev.mjs` | 依赖 ingest/units/facts |

对应测试一并删除；保留 reader/chunk/spans/topics/vectors/curator/selector/inject/plugin-spec 的测试。

## 工具面（最终）

```
memory(action="search", query)      → span 检索（词法 + 可选向量）
memory(action="recall", question)   → 主题召回 + 选择器，返回概括与索引
memory(action="read", session_id, seq) → 原生原始事件（含思考链），回退会话文件
memory(action="trace", session_id)  → 原生会话血缘
```

`state` / `history` / `write` 随 facts 删除。

## 数据库

- migrate 只建 6 张新表
- 对旧库执行 `DROP TABLE IF EXISTS facts, units, events, sessions, cards, card_quotes, usage, span_fts(若v1无)` —— 这些全是派生数据，可从会话文件重建
- 保留 `curations` 记录整理批次

## 会话开始注入

改成一小段静态指令（替代原状态表）：

```
## 项目记忆
这个项目有历史整理好的主题与 span。问「现在是什么 / 当时为什么 / 以前做过没有」时，
先用 memory(action="recall", question=...)；需要原话或血缘时用 memory(action="read"/"trace")。
```

## 验收

1. `node --test` 全绿（删除对应测试后）
2. `node --check` 所有保留文件
3. `node scripts/curate.mjs --dry-run` 可跑
4. 插件在 mock 下能加载（无 @deepseek-ai 依赖时用 node --check 验语法）
5. 行数：src 总量从约 7000 降到 4000 以下
