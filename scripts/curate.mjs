#!/usr/bin/env node
// v3 整理 CLI：把会话文件里某个会话的 turn 整理成 span + topic。
//
//   node scripts/curate.mjs --db .dev/v3.db --scope <cwd> --session <id> \
//     [--turns-per-batch 5] [--max-turns 20] [--dry-run]
//   node scripts/curate.mjs --db .dev/v3.db --scope <cwd> --latest \
//     [--turns-per-batch 5] [--max-turns 20] [--topic-dir <dir>]
//
// 数据来源：直接扫描会话目录（默认 ~/.dsh/sessions）并读会话文件，
// 能拿回 reasoning / step / 工具参数，不依赖任何 v1 索引表。
//
// 安全：
//   - 凭据只从环境变量 / ~/.dsh/.credentials.yaml 读取，不打印、不写库。
//   - 未配置凭据时打印一句提示并以 0 退出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/core/db.js';
import { chatJson, redactSecrets, resolveLlmConfig } from '../src/core/llm.js';
import { listSessionFiles, readSessionFile } from '../src/core/reader.js';
import { curateSession } from '../src/core/curator.js';

const DEFAULT_SESSIONS_ROOT = String(process.env.DSH_SESSIONS_ROOT ?? '').trim()
  || path.join(os.homedir(), '.dsh', 'sessions');

const DEFAULTS = {
  db: path.resolve('.dev', 'v3.db'),
  turnsPerBatch: 5,
  maxTurns: 20,
};

const HELP = `dsh-recall v3 整理（模型参与）

  node scripts/curate.mjs --db <file> --scope <cwd> (--session <id> | --latest)
    [--turns-per-batch 5] [--max-turns 20] [--dry-run] [--topic-dir <dir>]
    [--sessions-root <dir>]

  --db              索引库文件（默认 ${DEFAULTS.db}）
  --scope           项目 cwd；不给时用会话自己的 cwd
  --session         要整理的会话 id（也接受 session- 前缀）
  --latest          取该 scope 最近修改的一个会话
  --turns-per-batch 每批几轮（默认 ${DEFAULTS.turnsPerBatch}）
  --max-turns       最多整理最近多少轮（默认 ${DEFAULTS.maxTurns}；也可按需调小）
  --dry-run         只打印解析出的 span，不写库
  --topic-dir       topic md 输出目录（默认 ~/.dsh/recall/topics）
  --sessions-root   会话目录（默认 ${DEFAULT_SESSIONS_ROOT}）

  凭据顺序：DSH_RECALL_API_KEY / DEEPSEEK_API_KEY / ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
  没有凭据时打印「未配置模型凭据，跳过整理」并退出（退出码 0）。
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

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} 必须是正整数，收到：${value}`);
  }
  return Math.trunc(parsed);
}

/** 文本前 N 字（按字符切，中文算 1）。 */
function prefix(text, limit) {
  const chars = Array.from(String(text ?? ''));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('')}…`;
}

function formatSpanLine(span) {
  const turns = Array.isArray(span.turns) && span.turns.length > 0
    ? span.turns.join(',')
    : '?';
  return `  + [${span.type}] ${prefix(span.text, 40)} (turns ${turns})`;
}

/** 路径归一化：Windows 下大小写与斜杠不敏感。 */
function scopeKey(value) {
  const text = String(value ?? '').trim().replace(/[\\/]+$/, '');
  if (!text) return '';
  return process.platform === 'win32'
    ? text.replace(/\//g, '\\').toLowerCase()
    : text;
}

/** 会话 id 兼容带不带 session- 前缀。 */
function idVariants(rawId) {
  const id = String(rawId ?? '').trim();
  if (!id) return new Set();
  return new Set([id, id.replace(/^session-/, ''), `session-${id}`]);
}

function findSessionFile(files, rawId) {
  const wanted = idVariants(rawId);
  return files.find((file) => wanted.has(String(file.id))) ?? null;
}

function latestSessionFile(files, scope) {
  const key = scopeKey(scope);
  const candidates = key
    ? files.filter((file) => scopeKey(file.cwd) === key)
    : [...files];
  candidates.sort((a, b) => Number(b.mtime) - Number(a.mtime) || String(b.path).localeCompare(String(a.path)));
  return candidates[0] ?? null;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const hasSession = typeof flags.session === 'string' && flags.session.trim() !== '';
  const latest = isOn(flags.latest);
  if (hasSession && latest) throw new Error('--session 和 --latest 只能给一个');
  if (!hasSession && !latest) {
    console.log(HELP);
    throw new Error('需要 --session <id> 或 --latest');
  }

  const turnsPerBatch = flags['turns-per-batch'] === undefined
    ? DEFAULTS.turnsPerBatch
    : positiveInt(flags['turns-per-batch'], '--turns-per-batch');
  const maxTurns = flags['max-turns'] === undefined
    ? DEFAULTS.maxTurns
    : positiveInt(flags['max-turns'], '--max-turns');
  const dryRun = isOn(flags['dry-run']);
  const dbPath = path.resolve(expandHome(
    typeof flags.db === 'string' ? flags.db : DEFAULTS.db,
  ));
  const scopeFlag = typeof flags.scope === 'string' ? flags.scope.trim() : '';
  const topicDir = typeof flags['topic-dir'] === 'string'
    ? path.resolve(expandHome(flags['topic-dir']))
    : null;
  const sessionsRoot = path.resolve(expandHome(
    typeof flags['sessions-root'] === 'string' ? flags['sessions-root'] : DEFAULT_SESSIONS_ROOT,
  ));

  const config = resolveLlmConfig();
  if (!config.available) {
    console.log('未配置模型凭据，跳过整理');
    return;
  }

  let files;
  try {
    files = listSessionFiles(sessionsRoot);
  } catch (error) {
    throw new Error(`扫描会话目录失败 ${sessionsRoot}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (files.length === 0) {
    console.log(`[curate] ${sessionsRoot} 下没有会话文件`);
    return;
  }

  const file = hasSession
    ? findSessionFile(files, flags.session)
    : latestSessionFile(files, scopeFlag);
  if (!file) {
    console.log(hasSession
      ? `[curate] 找不到会话：${flags.session}`
      : `[curate] ${scopeFlag ? `scope ${scopeFlag} 下` : '会话目录里'}没有会话`);
    return;
  }

  let parsed;
  try {
    parsed = readSessionFile(file.path);
  } catch (error) {
    throw new Error(`读取会话文件失败 ${file.path}：${error instanceof Error ? error.message : String(error)}`);
  }
  const scope = scopeFlag || String(parsed.header?.cwd ?? '').trim();
  if (scope === '') throw new Error('会话没有 cwd，必须用 --scope 指定项目路径');

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const startedAt = process.hrtime.bigint();

  try {
    console.log(
      `[curate] session=${file.id} scope=${scope} db=${dbPath} `
        + `model=${config.model} 事件=${parsed.events.length}（session-file）`
        + `${dryRun ? ' dry-run' : ''}`,
    );

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

    const stats = await curateSession(db, {
      sessionId: file.id,
      scope,
      turnsPerBatch,
      maxTurns,
      dryRun,
      events: parsed.events,
      topicDir: topicDir ?? undefined,
      complete,
      onBatch: (info) => {
        if (info.error) {
          console.error(
            `[curate] 批次 ${info.index} 失败：`
              + `${redactSecrets(info.error.message ?? String(info.error))}`,
          );
          return;
        }
        const turns = info.turns.map((turn) => turn.turn).join(',');
        console.log(
          `[curate] 批次 ${info.index} · turns ${turns} → `
            + `span ${info.result.spans.length} · topic ${info.result.topics.length}`
            + `${info.result.rejectedSpans > 0 ? ` · 丢弃 span ${info.result.rejectedSpans}` : ''}`,
        );
        if (dryRun) {
          for (const span of info.result.spans) console.log(formatSpanLine(span));
        }
      },
    });

    const totalSpans = dryRun ? stats.spans : stats.inserted;
    console.log(
      `[curate] 完成：批次 ${stats.batches} · span ${totalSpans} · topic ${stats.topics} · `
        + `模型调用 ${calls} · 耗时 ${elapsedSince(startedAt)}`,
    );
    if (stats.rejectedSpans > 0) {
      console.log(`[curate] 丢弃 span ${stats.rejectedSpans} 条（type/长度/turn/evidence 不合法）`);
    }
    if (stats.failures > 0) {
      console.log(`[curate] 失败批次 ${stats.failures} 个（已跳过，未中断）`);
    }
    if (stats.batches === 0) console.log('[curate] 没有可整理的轮次');
    if (dryRun) console.log('[curate] dry-run：以上为预览，未写入 span / topic');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[curate] 失败：${redactSecrets(message)}`);
  process.exitCode = 1;
});
