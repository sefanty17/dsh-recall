# dsh-recall 设计规格 v0.1

> 状态：实现契约。所有子任务以本文为准；如需偏离，先在报告里说明，不要擅自改 DDL 或接口。

## 1. 目标与非目标

**目标**：给 DeepSeek Harness 加一层「项目记忆」——记住决策、偏好、约定、失败经验；检索回来的每一条都自带状态（是否仍有效）、原始证据和时间。

**非目标**：

- 不做人物/聊天陪伴记忆
- 不做全库摘要，不改写原文
- 不替换 DSH 的会话存储、压缩、session 工具
- v1 不做向量检索（留接口）、不做跨项目全局合并、不做 skills 抽取

**三条铁律**：

1. 原文只读，一个字节不改；`session.v3.jsonl.zstd` 是唯一事实来源
2. 索引是派生品，随时可删可重建
3. 上层只负责路由和状态，回答永远来自原文

## 2. 架构

```
DSH 会话日志（只读）
   │  src/core/reader.js        解码 zstd 多帧 → header + events
   ▼
src/core/ingest.js              事件 → units（span 级）+ events 元数据
   │
   ├─ src/core/rules.js         规则扫描 → 候选事实
   ├─ src/core/facts.js         状态表：合并、supersede、推导
   ├─ src/core/cards.js         （v0.2）主题卡
   ▼
src/core/db.js (SQLite)          units / events / facts / cards / usage
   │
   ▼
src/core/search.js              召回 → 过滤 → 折叠 → 邻域 → 打包
   │
   ▼
src/core/format.js              自足单元文本
   │
   ▼
src/plugin/index.js             Cordis 插件：1 个 memory 工具 + 常驻提示段 + 事件观察
```

## 3. 数据模型（冻结）

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  path          TEXT,
  cwd           TEXT,
  created_at    INTEGER,
  parent_id     TEXT,
  origin        TEXT,
  event_count   INTEGER NOT NULL DEFAULT 0,
  ingested_at   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  time          INTEGER,
  surface       TEXT,                  -- current | shadowed | log-only | NULL
  author        TEXT,                  -- user | assistant | tool | system
  text          TEXT,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS units (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  start         INTEGER NOT NULL,      -- 字符偏移，闭区间
  end           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  search_text   TEXT NOT NULL,         -- segmentCJK(text) 的结果，只用于索引
  time          INTEGER,
  author        TEXT,
  surface       TEXT,
  UNIQUE (session_id, seq, start)
);

CREATE VIRTUAL TABLE IF NOT EXISTS unit_fts USING fts5(
  search_text,
  unit_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS facts (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,
  value           TEXT,
  scope           TEXT NOT NULL,       -- cwd 绝对路径，或 'global'
  kind            TEXT NOT NULL,       -- decision|preference|constraint|failure|fact|todo
  status          TEXT NOT NULL DEFAULT 'active',  -- active|superseded|disputed|archived
  since           INTEGER,
  verified_at     INTEGER,
  drift           TEXT,                -- stable|slow|fast
  quote           TEXT,
  note            TEXT,                -- 模型自由文字，author 标注
  author          TEXT NOT NULL,       -- user|agent|rule
  verified        INTEGER NOT NULL DEFAULT 0,  -- 引文是否与原文逐字一致
  evidence_session TEXT,
  evidence_seq    INTEGER,
  span_start      INTEGER,
  span_end        INTEGER,
  supersedes      TEXT,                -- 旧 fact id
  superseded_by   TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_key_scope ON facts (key, scope, status);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS card_quotes (
  card_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  span_start  INTEGER,
  span_end    INTEGER,
  quote       TEXT,
  role        TEXT,                    -- decision|reason|constraint|context
  PRIMARY KEY (card_id, session_id, seq, role)
);

CREATE TABLE IF NOT EXISTS usage (
  ref_type    TEXT NOT NULL,           -- fact|card|unit
  ref_id      TEXT NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_used   INTEGER,
  PRIMARY KEY (ref_type, ref_id)
);
```

## 4. 模块接口（冻结）

```js
// src/core/db.js
export function openDb(filePath)                  // → DatabaseSync，自动 migrate + PRAGMA
export function migrate(db)

// src/core/reader.js
export function listSessionFiles(sessionsRoot)    // → [{ id, path, cwd, mtime, size }]
export function readSessionFile(path)             // → { header, events }
export function decodeZstdFrames(buffer)          // → Buffer[]（每个完整帧）

// src/core/chunk.js
export function chunkText(text, opts)             // → [{ start, end, text }]
export function attributeOf(event)                // → 'user' | 'assistant' | 'tool' | 'system'
export function segmentCJK(text)                  // → 汉字两侧加空格的索引文本
export function ftsPhrase(term)                   // → 加引号转义的 FTS5 phrase（内部先 segmentCJK）

// src/core/ingest.js
export function ingestSession(db, { header, events })   // → { units, events }
export function ingestAll(db, sessionsRoot, { onProgress })
export function computeSurfaces(events)                  // → Map<seq, 'current'|'shadowed'|'log-only'>

// src/core/rules.js
export function scanText(text, { time, author })  // → Candidate[]
// Candidate: { keyHint, kind, value, quote, drift, confidence, evidence:{start,end} }

// src/core/facts.js
export function upsertFact(db, fact)              // → { fact, superseded }
export function listFacts(db, { scope, status, key })
export function factHistory(db, { key, scope })   // → Fact[]（按 since 升序）

// src/core/search.js
export function search(db, { query, scope, limit, includeSuperseded })
// → Hit[]：{ unit, event, session, fact?, score, reasons[] }
export function foldVersions(db, hits)
export function neighbors(db, hit, { before, after })

// src/core/format.js
export function formatHit(hit, ctx)               // → string（自足单元）
export function formatState(facts, ctx)           // → string（状态表）
export function formatSearchResult(hits, meta)    // → string（含下一步提示）
export function formatHistory(facts, ctx)         // → string

// src/core/service.js
export function createService({ db, scope })      // → { state, history, search, read, write }
```

`service` 是插件唯一依赖的门面，插件不直接碰 db。

## 5. 工具契约

只注册一个工具：

```
memory(
  action: "state" | "history" | "search" | "write",   // required
  query?: string,
  key?: string,
  content?: string,     // write：自由格式，服务端软解析
  scope?: string,       // 默认调用方 cwd
  limit?: number        // 默认 8
)
```

### 返回格式

`state`：

```
[memory.state] scope=D:\personal_vibe\dsh-recall · 6 active facts
pkg-manager      = pnpm        2026-03-06  user   e42
test-command     = pytest     2026-02-11  user   e17
❌never-use      = npm         2026-03-05  user   e38
...
→ 看某个键的演变：memory(action="history", key="pkg-manager")
```

`search`：

```
[memory.search] 3 hits · scope=... · active only
1. [failure] 2026-03-05 10:20 · user
   "npm 装不上，lockfile 跟 CI 冲突"
   ↳ session 019c6e… seq 31 [120,186]
   ↳ 上下文：前一条在跑 npm ci
→ 完整上下文：session_event_read(session_id="019c6e…", seq=31)
```

`history`：

```
[memory.history] pkg-manager · 3 versions
2026-03-02  npm    "这个项目用 npm 就行"        e12  superseded
2026-03-05  pnpm   "npm 装不上，换 pnpm 吧"     e31  superseded
2026-03-06  pnpm   "CI 只认 pnpm-lock…"        e42  ACTIVE
```

`write`：

```
[memory.write] ok · fact pkg-manager=pnpm · verified=true · superseded 1
```

### 提示规则

- 只在相关时给「下一步」提示，不做固定模板
- 命中已废弃事实 → 提示用 `history`
- 有 session/seq → 提示可用 `session_event_read`

## 6. 写入路径（软校验）

- 引文与原文不一致 → 照写，`verified=0`，`author` 保留
- 未提供引文 → 存 `note`，`kind=fact`，`verified=0`
- 新 key → 允许，记录到别名表（v0.2）
- 同一 key 新值 → 新 fact + `supersedes` 旧 id；旧 fact `status='superseded'`，不删除
- 触发点（互相独立，任一可用即可）：模型主动调用 / 会话空闲 10 分钟 / 轮次 ≥ 20 / 观察到 compaction checkpoint（**只观察，不耦合**）

## 7. 读取流水线 v1

1. 查询补全：query 原样 + 可选拼当前 scope 名
2. 召回：`unit_fts MATCH`（整句加引号做 phrase，再 fallback OR 分词）
3. 过滤：scope（join sessions.cwd）、surface、status
4. 打分：bm25 + 时间衰减 + 权威加权（user > assistant > tool）+ 当前 surface 加分
5. 折叠：同 key 多 fact → 只留最新
6. 邻域：±1 事件（只在预算允许时）
7. 打包：默认 8 条 / 3000 token 上限
8. 格式化

**中文检索必须按字切分（已实测）**。`unicode61` 会把连续汉字当成一个整词，导致「包管理器」搜不到「作为包管理器」；`trigram` 能搜到 3 字以上，但 2 字词（「启动」「测试」）完全失效。

v1 的方案：入库前把每个汉字两侧加空格，写成 `search_text`，FTS5 索引它；查询时用同样规则切分并作为 phrase 加引号。

```js
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
export function segmentCJK(text) {
  let out = '';
  for (const ch of text) out += CJK.test(ch) ? ` ${ch} ` : ch;
  return out.replace(/\s+/g, ' ').trim();
}
```

实测结果（4 条中文语料）：`包管理器 / 启动 / 测试 / 迁移脚本 / 以后都用` 全部命中，`pnpm-lock` 也正常。

## 8. 仓库结构

```
package.json            type=module, engines node>=22.19, 无运行时依赖
src/core/*.js           纯 Node，不 import DSH 包
src/plugin/index.js     Cordis 插件，唯一依赖 @deepseek-ai/*
scripts/dev.mjs         本地跑：ingest 真实会话 + 跑查询 + 打印
scripts/eval.mjs        评测：读查询文件，批量跑，输出命中统计
test/*.test.js          node:test
fixtures/               小样本会话（≤50KB）
docs/design.md          本文
```

## 9. 评测

- `eval/queries.jsonl`：`{ query, scope, expect: { session_id, seq } | null, note }`
- 指标：Hit@1（返回的 seq 命中 expect）、MRR、平均返回 token、耗时
- 先用 20 条手写查询跑通，再扩到 50

## 10. 任务拆分

| 任务 | 文件 | 依赖 |
|---|---|---|
| A 地基 | package.json、db.js、reader.js、chunk.js、test/reader.test.js、fixtures | 无 |
| B 写入 | rules.js、facts.js、ingest.js、test/rules.test.js | A 的接口 |
| C 读取 | search.js、format.js、service.js、test/search.test.js | A 的接口 |
| D 接入 | plugin/index.js、scripts/dev.mjs、scripts/eval.mjs | C 的 service 接口 |
