# dsh-recall

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一层**项目记忆地图**：把会话日志整理成 span（决策 / 操作 / 叙述）和 topic（主题 md），回答「现在是什么 / 当时为什么 / 以前做过没有」时按主题召回，再用选择器挑出最相关的 span，注入概括和轮次索引。

- **是什么**：一个 DSH 插件（`memory` 工具 + 一段常驻提示 + 每轮注入 + 后台整理），加一个本地整理 CLI。
- **不是什么**：不存状态表、不做键值事实、不改写原文；原文始终以会话文件为准。

## 结构

```
会话文件（只读）
  → curator 整理：span（decision / operation / narrative）+ topic（md）
  → 问题：主题阈值召回 → 选择器（开主题、选 span）→ 注入概括 + 轮次索引
  → 模型主动：span 搜索 / 原生会话搜索
```

## 安装

纯 Node ESM，无运行时依赖（Node ≥ 22.19，需要内置 `node:sqlite`）。

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

3. 在 profile 目录执行 `pnpm install`，然后重启 DSH（或等 HMR）。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dbPath` | `~/.dsh/recall/index.db` | SQLite 索引文件（只存 v2 的 span/topic 六张表），父目录自动创建；可随时删除重建 |
| `sessionsRoot` | `~/.dsh/sessions` | 会话日志根目录（只读） |
| `scope` | 无 | 拿不到 agent cwd 时的兜底项目路径，一般不用填 |
| `spanEveryTurns` | `5` | 每多少个 `turn/end` 触发一次后台整理 |
| `turnsPerBatch` | `5` | 每次送给 curator 的轮数 |
| `topicDir` | `~/.dsh/recall/topics` | 主题 md 目录；每个 scope 一个子目录，可被 `DSH_RECALL_TOPIC_DIR` 覆盖 |
| `selectorInjection` | `true` | 每轮在 `system-prompt/assemble` 跑选择器；关掉则退回常驻词法注入 |
| `selectorTimeoutMs` | `3500` | 选择器超时；超时退回同步词法结果，不阻塞组装 |
| `maxTopics` | `8` | 进入选择器的候选主题上限 |
| `threshold` | `0.58` | 有向量时的余弦阈值 |
| `lexicalThreshold` | `0.55` | 无向量时的主题词法代理阈值 |
| `maxInjectLines` | `200` | 每轮注入的安全行数上限 |

## 工具：四个 action

```
memory(action="search", query)            → span 检索（词法 + 可选向量），输出 [memory.search]
memory(action="recall", question)         → 主题召回 + 选择器，输出 [memory.recall] topics=… spans=…
memory(action="read", session_id, seq)    → 事件原始 JSON（含思考链），优先原生，回退会话文件
memory(action="trace", session_id?)       → 会话血缘，优先原生 traceSession，不可用返回提示
```

- `scope` 默认当前会话 cwd，`limit` 默认 8。
- `read` 先走原生 `sessionQuery.readEvent`（3 秒超时）；失败后用 `reader.readSessionFile` 按 seq 找事件。
- `trace` 需要 DSH 的 `session-query` 服务；缺席时只返回一条说明，不报错。

## 整理

后台：插件监听 `session/event`，每 `spanEveryTurns` 轮把**新增**的事件交给 `curateSession` 整理一次（同一会话不并发，失败只记日志）。

手动（会真实调用模型）：

```bash
node scripts/curate.mjs --db .dev/v3.db --scope "D:\personal_vibe\companion" --latest \
  --turns-per-batch 5 --max-turns 3 --dry-run       # 预览，不写库

node scripts/curate.mjs --db .dev/v3.db --scope "D:\personal_vibe\companion" --session <id> \
  --turns-per-batch 5 --max-turns 20 --topic-dir .dev/topics    # 正式写入
```

- 会话来源：直接扫描 `--sessions-root`（默认 `~/.dsh/sessions`）并读会话文件，不依赖 v1 索引表。
- `--latest` 取该 scope 最近修改的会话；`--dry-run` 只打印解析出的 span。
- 凭据顺序：`DSH_RECALL_API_KEY` → `DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`；没有凭据时打印提示并以 0 退出。
- 主题目录自成 git 仓库，每次生成后提交；人改过的内容会保留，模型新建议落在文件末尾 `## 待合并`。

## 已知限制

- **没有 facts / 状态表**：`state` / `history` / `write` 已删除；要记结论就写进代码或文档。
- **scope 是 cwd 精确匹配**：在 `D:\proj\sub` 里看不到 `D:\proj` 的记忆，暂不支持父子目录继承。
- **向量默认关闭**：`backend=none`，只走词法代理；要开需配 `DSH_RECALL_EMBED_*` 或本地 ONNX，且要自己装包。
- **需要模型凭据**：选择器和后台整理都用环境里的模型；没有凭据时自动降级为词法召回 / 跳过整理。
- **后台整理按新增 seq 增量**：会话文件被整体改写 / seq 重排时需要手动重跑 `curate`。
- **索引是派生数据**：删除 `dbPath` 和 topic 目录即可重建，原文不受影响。

测试：`node --test`。
