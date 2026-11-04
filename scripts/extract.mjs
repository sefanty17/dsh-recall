#!/usr/bin/env node
// L2 模型抽取 CLI：只读会话文件，把模型抽出的项目事实写进索引库。
//
//   node scripts/extract.mjs --db .dev/l2.db --root .data/sessions-copy \
//     [--max-sessions 5] [--force] [--dry-run] [--project D:\personal_vibe\companion]
//
// 安全：
//   - --root 默认 .data/sessions-copy（真实数据的只读副本），绝不指向 DSH 的会话目录
//   - API key 只从环境变量 / ~/.dsh/.credentials.yaml 读取，不打印、不写库
//   - 未配置凭据时打印一句提示并以 0 退出
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core/db.js';
import { extractAll } from '../src/core/extract.js';
import { chatJson, redactSecrets, resolveLlmConfig } from '../src/core/llm.js';

const DEFAULTS = {
  // 只用只读副本；不要改回 ~/.dsh/sessions
  root: path.resolve('.data', 'sessions-copy'),
  db: path.resolve('.dev', 'l2.db'),
};

const HELP = `dsh-recall L2 抽取（模型参与）

  node scripts/extract.mjs [--db <file>] [--root <sessions-copy>]
    [--max-sessions <n>] [--force] [--dry-run] [--project <cwd>]

  --db            索引库文件（默认 ${DEFAULTS.db}）
  --root          会话目录（默认 ${DEFAULTS.root}，只读）
  --max-sessions  最多处理多少会话（默认不限）
  --force         忽略 llm_extracted_at，重抽已处理的会话
  --dry-run       只打印将要写入的事实，不写 facts / 幂等标记
  --project       只处理 cwd 精确匹配该路径的会话

  凭据顺序：DSH_RECALL_API_KEY / DEEPSEEK_API_KEY / ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
  没有凭据时打印「未配置模型凭据，跳过 L2」并退出（退出码 0）。
`;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function isOn(value) {
  return value === true || value === 'true' || value === '1';
}

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function elapsedSince(startedAt) {
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatFactLine(fact) {
  const value = fact.value === null || fact.value === undefined ? '∅' : String(fact.value);
  const quote = String(fact.quote ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return `  + ${fact.key}=${value} (${fact.kind}) seq=${fact.seq} "${quote}"`;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const root = path.resolve(expandHome(flags.root ?? DEFAULTS.root));
  const dbPath = path.resolve(expandHome(flags.db ?? DEFAULTS.db));
  const dryRun = isOn(flags['dry-run']);
  const force = isOn(flags.force);
  const project = typeof flags.project === 'string' ? flags.project : null;

  let maxSessions = Infinity;
  if (flags['max-sessions'] !== undefined && flags['max-sessions'] !== true) {
    const parsed = Number(flags['max-sessions']);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`--max-sessions 必须是非负整数，收到：${flags['max-sessions']}`);
    }
    maxSessions = Math.trunc(parsed);
  }

  const config = resolveLlmConfig();
  if (!config.available) {
    console.log('未配置模型凭据，跳过 L2');
    return;
  }

  console.log(
    `[extract] root=${root} db=${dbPath} model=${config.model}`
      + `${dryRun ? ' dry-run' : ''}${force ? ' force' : ''}`,
  );

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const startedAt = process.hrtime.bigint();
  let calls = 0;

  const complete = async (messages) => {
    calls += 1;
    return chatJson({
      messages,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
  };

  try {
    const stats = await extractAll(db, root, {
      complete,
      maxSessions,
      force,
      dryRun,
      project,
      onFact: (fact) => {
        if (dryRun) console.log(formatFactLine(fact));
      },
      onProgress: (info) => {
        if (info.state !== 'processed') return;
        console.log(
          `[extract] ${info.done}/${info.total} ${info.id ?? '(unknown)'} · `
            + `用户消息 ${info.messages} 条 → 插入 ${info.inserted} · `
            + `更新 ${info.updated} · 丢弃 ${info.rejected}`,
        );
      },
    });

    console.log(
      `[extract] 完成：会话 ${stats.sessions} · 模型调用 ${calls} · `
        + `插入 ${stats.inserted} · 更新 ${stats.updated} · 丢弃 ${stats.rejected} · `
        + `耗时 ${elapsedSince(startedAt)}`,
    );
    if (stats.failed > 0) console.log(`[extract] 失败会话 ${stats.failed} 个（已跳过，未中断）`);
    if (stats.skipped > 0) console.log(`[extract] 跳过会话 ${stats.skipped} 个（已处理/子代理/无用户消息/项目不匹配）`);
    if (stats.sessions === 0 && stats.failed === 0) {
      console.log('[extract] 没有可处理的会话');
    }
    if (dryRun) {
      console.log('[extract] dry-run：以上为预览，未写入 facts / llm_extracted_at');
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[extract] 失败：${redactSecrets(message)}`);
  process.exitCode = 1;
});
