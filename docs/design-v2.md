# dsh-recall v2：span / topic 地图层

> 实现契约。所有子任务以此为准；DDL、JSON 契约、接口签名冻结，偏离必须先在报告里说明。

## 1. 目标

在现有「原始事件 + unit + facts」之上，加两层地图：

```
topic（主题，~300 字描述，md 文件，可手改）
  ↑
span（语义单元：决策 / 操作 / 叙述，带轮次指针）
  ↑
raw（原始事件，含思考链、正文、工具调用）
```

写入：每 N 轮整理一次，**一次产出 span 和 topic**。
读取：问题 → 主题阈值召回 → 选择器（带 open_topic 工具）→ 注入 span 概括 + 轮次索引。

## 2. 数据模型（冻结）

```sql
CREATE TABLE IF NOT EXISTS spans (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  type          TEXT NOT NULL,        -- decision | operation | narrative
  text          TEXT NOT NULL,        -- 模型概括（允许改写，但必须能被 evidence 支撑）
  turns         TEXT NOT NULL,        -- JSON 数组，如 [7,9]
  evidence      TEXT NOT NULL,        -- JSON 数组 [{session_id, seq, turn}]
  rationale_from TEXT,                -- user | assistant | reasoning | tool
  batch_id      TEXT,                 -- 哪次整理产出
  session_ids   TEXT,                 -- JSON 数组
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS spans_scope ON spans (scope, type);

CREATE VIRTUAL TABLE IF NOT EXISTS span_fts USING fts5(
  search_text, span_id UNINDEXED, tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS span_vectors (
  span_id   TEXT PRIMARY KEY,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vec       BLOB NOT NULL            -- float32 little-endian
);

CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  file        TEXT NOT NULL,
  span_ids    TEXT NOT NULL,         -- JSON 数组
  content_hash TEXT,
  updated_at  INTEGER NOT NULL,
  UNIQUE (scope, slug)
);

CREATE TABLE IF NOT EXISTS topic_vectors (
  topic_id TEXT PRIMARY KEY,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS curations (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  session_id TEXT,
  from_seq   INTEGER,
  to_seq     INTEGER,
  spans      INTEGER,
  topics     INTEGER,
  created_at INTEGER NOT NULL
);
```

## 3. LLM 契约（冻结）

### 3.1 span 抽取

输入：某一批对话（含 turn 号、role、文本；工具调用压缩成「工具名 + 参数前 200 字 + 输出前 500 字」；reasoning 保留前 800 字）。

输出严格 JSON：

```json
{"spans":[
  {"type":"decision","text":"决定 TTS 情感参数走独立配置文件","turns":[7],"evidence":[{"seq":8121,"turn":7}],"rationale_from":"reasoning"},
  {"type":"operation","text":"读 agent_search 仓库 12 个文件，定位搜索实现","turns":[8,9],"evidence":[{"seq":8150,"turn":8}],"rationale_from":"tool"},
  {"type":"narrative","text":"用户描述自己喜欢的水果和香水类型及原因","turns":[10],"evidence":[{"seq":8200,"turn":10}],"rationale_from":"user"}
]}
```

规则（写进 prompt）：
- 按真实时间排序输出
- 操作类：**一个 step 内的所有工具调用合并成一条**；只记输入、输出、一句极简描述；连续的、中间没有实质内容的 step 可以合并
- 叙述类：用户偏好/习惯、我们做了什么、目标、手头材料；**大段读文件归操作类**
- 决策类：技术或方向层面的取舍
- 概括粒度：不漏、不过细（用户讲了水果和香水 → 写「描述了他喜欢的水果类型和香水类型及原因」，不能写「表达了一些喜好」）
- `turns` 可以是多个（跨轮合并）
- `rationale_from` 标明理由来自哪：user/assistant/reasoning/tool
- 没有可整理的 → `{"spans":[]}`

### 3.2 主题归组

输入：本次新增 span（id + type + text + turns）+ 现有主题列表（slug + title + description）。

输出：

```json
{"topics":[
  {"slug":"tts-emotion","title":"TTS 情感与显存","description":"这个主题收了 5 条：情感参数导致显存溢出的排查、降 batch 的决定、配置文件的方案……","span_ids":["sp_1","sp_2"]},
  {"slug":"new-topic","title":"...","description":"...","span_ids":["sp_9"]}
]}
```

规则：
- 分类只看内容，与 span 类型无关
- 同一 span 可以出现在多个主题
- 描述 ≤300 字，要写出「这个主题下有哪些内容」，不能只写标题
- 已有主题优先复用；只有内容明显不同才新建

### 3.3 选择器

输入：用户问题、候选主题（slug + title + description）、当前激活工具名列表。
工具：`open_topic(topic_id)` → 返回该主题下 span 的 `{id, type, text, turns}`。

输出：

```json
{"selected":[{"span_id":"sp_1","why":"直接回答了情感参数怎么配"}],"skip":false}
```

规则：最多打开 4 个主题；没有有用的返回 `{"selected":[],"skip":true}`。

## 4. 阈值与召回（冻结）

- 有向量：`cosine >= threshold`（默认 0.58）
- 无向量：用词法代理分 `normalized_bm25 * coverage`（默认阈值 0.55）
- 一个都不过线 → 不注入任何主题
- 最多 8 个主题进入选择器

## 5. 主题文件（冻结）

路径：`~/.dsh/recall/topics/<scopeSlug>/<topicSlug>.md`

```markdown
---
title: TTS 情感与显存
updated: 2026-11-05T00:00:00.000Z
spans:
  - sp_1
  - sp_2
---

（≤300 字描述，模型写；人可以改）

## spans
- [decision] 决定情感参数走独立配置文件（turns 7）
- [operation] 读 12 个文件定位搜索实现（turns 8,9）
```

git：该目录 `git init`；每次生成前 `git status --porcelain` 检查，若有未提交改动 → 视为人改，保留其 hunk，只更新其余部分（三方合并；冲突时保留人改版本，把模型新内容追加到文件末尾 `## 待合并` 区）；生成后 `git add -A && git commit`。

## 6. 模块（冻结接口）

```js
// src/core/spans.js
export function insertSpans(db, spans)              // → { inserted, ids }
export function listSpans(db, { scope, ids, limit })
export function searchSpans(db, { query, scope, limit, threshold })
export function spanById(db, id)

// src/core/topics.js
export function listTopics(db, { scope })
export function upsertTopic(db, topic)              // 写 md + 表 + 向量
export function readTopicFile(path)                 // 解析 frontmatter + body

// src/core/vectors.js
export function resolveEmbeddingConfig(env)         // { backend:'none'|'http'|'local', model, dim, available }
export async function embedTexts(texts, cfg)        // → Float32Array[] | null
export function cosine(a, b)
export function saveSpanVectors(db, rows)
export function loadTopicVectors(db, scope)

// src/core/curator.js
export async function curateBatch(db, { scope, sessionId, turns, complete, embed })
// 输入这一批 turn 的原始事件，出 span + topic，写库写文件
export async function curateSession(db, { sessionId, scope, complete, ... })

// src/core/selector.js
export async function selectSpans({ question, topics, activeTools, complete, openTopic })
// → { selected:[{span_id, why}], skip }

// src/plugin/inject.js
export async function buildInjection({ db, scope, question, activeTools, complete, cfg })
// → { text, topicsUsed, spansUsed }
```

## 7. 插件接入（冻结）

- `inject` 增加可选 `sessionQuery`
- `memory.read`：优先 `ctx.sessionQuery` 的原生 `session_event_read`（拿原始 JSON，含 reasoning），失败回退本地 `events.text`
- 新增 `memory(action="trace", session_id)`：转发原生 `session_trace`
- `memory.search`：主路径走 span 检索；`spans` 为空且索引为空时回退原生 `session_search`
- 每轮注入：在 prompt context 里调用 `buildInjection`，替换原来的纯状态表（状态表保留在最前面，注入内容附在其后）
- 无预算上限，安全上限 200 行

## 8. 配置（冻结）

```
spanEveryTurns: 5
topicEveryTurns: 5        // 与 span 同批，一次产出
threshold: 0.58
lexicalThreshold: 0.55
maxTopics: 8
maxInjectLines: 200
topicDir: ~/.dsh/recall/topics
embedding: { backend: 'none', model: 'bge-small-zh-v1.5', httpUrl: null }
```

## 9. 验收

1. `node --test` 全绿（现有 152 + 新增）
2. CLI：`node scripts/curate.mjs --db .dev/v2.db --scope <cwd> --session <id> --max-turns 20` 能真跑，产出 span + topic md
3. 主题文件可手改，重跑后手改内容保留
4. 基准一（quote 片段找自己）：**relaxed Hit@1 ≥ 90%**（top-1 文本包含片段即算命中；strict seq 同时报告）
5. 基准二（改写问句）：报告现状，与改造前对比不下降
