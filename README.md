# dsh-recall

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一层**项目记忆**：把会话日志里的决策、偏好、约定、失败经验索引成可检索的事实；每条结论都带状态、时间和原文出处。

- **是什么**：一个 DSH 插件（一个 `memory` 工具 + 一段常驻提示 + 后台增量入库），加一套本地开发/评测脚本。
- **不是什么**：不做会话摘要，不改写、不删除原文；不替换 DSH 的会话存储、压缩和 `session_*` 工具；v1 不做向量检索。

## 安装

本仓库是纯 Node ESM，无运行时依赖（Node ≥ 22.19，需要内置 `node:sqlite`）。

1. 加进 profile 的依赖（示例 `~/.dsh/profiles/web/package.json`）：

```json
{
  "dependencies": {
    "dsh-recall": "file:D:/personal_vibe/dsh-recall"
  }
}
```

2. 在同一个 profile 的 `cordis.patch.yml` 里 insert 一个条目：

```yaml
- insert:
    - id: dsh-recall
      name: dsh-recall
      config:
        dbPath: C:\Users\<you>\.dsh\recall\index.db
```

3. 在 profile 目录执行 `pnpm install`，然后重启 DSH（或等 HMR）。装好后 `memory` 工具和「项目记忆」提示段就出现了。也可以用 DSH 插件管理器安装本地目录。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dbPath` | `~/.dsh/recall/index.db` | SQLite 索引文件，父目录会自动创建；可随时删除重建 |
| `sessionsRoot` | `~/.dsh/sessions` | 会话日志根目录（只读） |
| `scanIntervalMs` | `60000` | 后台扫描间隔，只处理没入库或 mtime 变过的会话 |
| `debounceMs` | `30000` | `session/event` 触发扫描的按会话防抖 |
| `maxContextFacts` | `36` | 常驻提示里最多列多少条事实（总行数上限 40） |
| `batchSize` | `3` | 每个入库批次几个会话（1–3；批次在 worker 里跑，批间让出事件循环） |
| `scope` | 无 | 拿不到 agent cwd 时的兜底 scope，一般不用填 |

## 工具

只有一个 `memory` 工具，五个 action：

- `state`：当前项目所有仍有效的事实一览。
- `history`：某个键（如 `pkg-manager`）的版本演变，含已废弃版本。
- `search`：按关键词检索，返回带原文出处和上下文的单元。
- `read`：读某条事件的原文（`session_id` + `seq`）。
- `write`：记录新约定；同一键的新值会 supersede 旧值，旧记录保留。

`scope` 默认取调用方会话的 cwd，`limit` 默认 8。原文只读，写入只新增派生事实。

## 本地开发

```bash
node scripts/dev.mjs ingest                       # 真实会话入库，打印会话/事件/units/耗时
node scripts/dev.mjs query "包管理器" --scope "D:\personal_vibe"
node scripts/dev.mjs state --scope "D:\personal_vibe"
node scripts/dev.mjs history pkg-manager --scope "D:\personal_vibe"
node scripts/eval.mjs                             # 手写查询集（manual，默认）
node scripts/eval.mjs --auto --max-queries 100    # 从 facts.quote 片段测索引自洽性
node scripts/eval.mjs --auto --manual             # auto / manual 两组分开报告
node scripts/gen-queries.mjs --db .dev/l2.db --out eval/queries-gen.jsonl   # 模型把事实改写成自然问题
node scripts/eval.mjs --queries eval/queries-gen.jsonl --db .dev/l2.db      # 自然问句的 Hit@1 / MRR
```

默认库是 `./.dev/index.db`，`--db` 可换；`--root` 可换会话目录。测试：`node --test`。

## L2 模型抽取（可选）

规则抽取只认高置信句式，覆盖有限。L2 用宿主模型（DeepSeek 的 OpenAI 兼容接口）把用户消息再读一遍：只处理用户真正说的话，引文必须逐字命中原文，否则丢弃；没有值得记的就返回空。

```bash
# 先用只读副本预览（会真实调用模型，但不写库）
node scripts/extract.mjs --db .dev/l2.db --root .data/sessions-copy --max-sessions 3 --dry-run

# 正式写入；--project 只处理某个 cwd，--force 重抽已处理会话
node scripts/extract.mjs --db .dev/l2.db --root .data/sessions-copy --max-sessions 20
node scripts/extract.mjs --db .dev/l2.db --root .data/sessions-copy --project "D:\personal_vibe\companion"
```

凭据读取顺序：`DSH_RECALL_API_KEY` → `DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（字面量或 `env:NAME` 都支持）。没有凭据时打印「未配置模型凭据，跳过 L2」并以 0 退出，不会崩。密钥不打印、不写库。

会话目录只读，`--root` 默认 `.data/sessions-copy`。处理完的会话写 `sessions.llm_extracted_at`，下次自动跳过；`--force` 可重跑。抽取出的 fact 标为 `author='llm'`、`verified=1`（引文已校验），和规则事实共用同一套 supersede / history。

## 已知限制

- **scope 是 cwd 精确匹配**：在 `D:\proj\sub` 里看不到 `D:\proj` 的记忆；暂时没有父子目录继承。
- **默认只有规则抽取**：覆盖率有限，真实项目常常只有 0–3 条；L2 模型抽取要显式运行 `scripts/extract.mjs`（见上），平时也可让模型在对话里主动 `memory(action="write")`。
- **索引是派生数据，可随时删除重建**：`node:sqlite` + 全量 unit 文本，语料大时库会比较大（256 个会话约 1 GB），重建需重新入库。
- **首次全量入库在后台慢慢跑**：解码/写库在 worker 里按批进行，不阻塞主线程（实测单次事件循环停顿约 100ms）；会话多时总时长可能几十秒，当前项目会优先入库。

