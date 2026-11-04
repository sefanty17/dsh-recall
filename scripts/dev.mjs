#!/usr/bin/env node
// 本地开发 harness：不经过 DSH，直接打开 core 和同一个 SQLite 文件。
//
//   node scripts/dev.mjs ingest [--root ~/.dsh/sessions] [--db ./.dev/index.db]
//   node scripts/dev.mjs query "包管理器用哪个" [--scope <cwd>] [--limit 8]
//   node scripts/dev.mjs state [--scope <cwd>]
//   node scripts/dev.mjs history pkg-manager [--scope <cwd>]
//   node scripts/dev.mjs read <session_id> <seq>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core/db.js';
import { ingestAll } from '../src/core/ingest.js';
import { createService } from '../src/core/service.js';

const DEFAULTS = {
  root: path.join(os.homedir(), '.dsh', 'sessions'),
  db: path.resolve('.dev', 'index.db'),
  limit: 8,
  scope: null,
};

const HELP = `dsh-recall dev harness

  node scripts/dev.mjs ingest  [--root <dir>] [--db <file>]
  node scripts/dev.mjs query   "<query>" [--scope <cwd>] [--limit 8] [--db <file>]
  node scripts/dev.mjs state   [--scope <cwd>] [--db <file>]
  node scripts/dev.mjs history <key> [--scope <cwd>] [--db <file>]
  node scripts/dev.mjs read    <session_id> <seq> [--db <file>]

默认 --root ${DEFAULTS.root}
默认 --db   ${DEFAULTS.db}
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
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
  return { command: positional[0], positional: positional.slice(1), flags };
}

function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function openConfiguredDb(file) {
  const dbPath = path.resolve(expandHome(file));
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  return { db, dbPath };
}

function count(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return Number(row?.n ?? row?.N ?? 0);
  } catch {
    return null;
  }
}

function elapsed(startedAt) {
  return `${(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1)}ms`;
}

function formatCount(value) {
  return value == null ? '?' : value.toLocaleString('en-US');
}

async function commandIngest({ flags }) {
  const root = path.resolve(expandHome(flags.root ?? DEFAULTS.root));
  const { db, dbPath } = openConfiguredDb(flags.db ?? DEFAULTS.db);
  const startedAt = process.hrtime.bigint();
  console.log(`[dev] ingest root=${root}`);
  console.log(`[dev]        db=${dbPath}`);
  let sessionsSeen = 0;
  try {
    const stats = ingestAll(db, root, {
      onProgress: (progress) => {
        sessionsSeen = Number(progress?.done ?? progress?.index ?? progress?.sessions ?? sessionsSeen);
        if (sessionsSeen > 0 && sessionsSeen % 25 === 0) {
          process.stdout.write(`\r[dev] 进度 ${sessionsSeen}/${progress?.total ?? '?'} 会话`);
        }
      },
    });
    if (sessionsSeen > 0) process.stdout.write('\n');
    const totalMs = elapsed(startedAt);
    console.log(
      `[dev] 完成：会话 ${formatCount(stats?.sessions ?? count(db, 'sessions'))}` +
        ` · 事件 ${formatCount(stats?.events ?? count(db, 'events'))}` +
        ` · units ${formatCount(stats?.units ?? count(db, 'units'))}` +
        ` · facts ${formatCount(stats?.facts ?? count(db, 'facts'))}` +
        ` · 耗时 ${totalMs}`,
    );
  } finally {
    db.close();
  }
}

function makeService(db, flags) {
  const scope = flags.scope ?? process.cwd();
  return createService({ db, scope });
}

async function commandQuery({ positional, flags }) {
  const query = positional[0];
  if (!query) throw new Error('缺少查询内容：node scripts/dev.mjs query "包管理器用哪个"');
  const limit = Number(flags.limit ?? DEFAULTS.limit) || DEFAULTS.limit;
  const { db, dbPath } = openConfiguredDb(flags.db ?? DEFAULTS.db);
  const service = makeService(db, flags);
  const startedAt = process.hrtime.bigint();
  try {
    const result = await service.search(query, { limit });
    console.log(`[dev] query=${JSON.stringify(query)} scope=${flags.scope ?? process.cwd()} db=${dbPath}`);
    console.log(String(result ?? '').trim() || '[dev] （没有结果）');
    console.log(`[dev] 耗时 ${elapsed(startedAt)}`);
  } finally {
    db.close();
  }
}

async function commandState({ flags }) {
  const { db, dbPath } = openConfiguredDb(flags.db ?? DEFAULTS.db);
  const service = makeService(db, flags);
  try {
    console.log(`[dev] state scope=${flags.scope ?? process.cwd()} db=${dbPath}`);
    console.log(String((await service.state()) ?? '').trim() || '[dev] （没有事实）');
  } finally {
    db.close();
  }
}

async function commandHistory({ positional, flags }) {
  const key = positional[0];
  if (!key) throw new Error('缺少键名：node scripts/dev.mjs history pkg-manager');
  const { db, dbPath } = openConfiguredDb(flags.db ?? DEFAULTS.db);
  const service = makeService(db, flags);
  try {
    console.log(`[dev] history key=${JSON.stringify(key)} scope=${flags.scope ?? process.cwd()} db=${dbPath}`);
    console.log(String((await service.history(key)) ?? '').trim() || '[dev] （没有记录）');
  } finally {
    db.close();
  }
}

async function commandRead({ positional, flags }) {
  const sessionId = positional[0];
  const seq = Number(positional[1]);
  if (!sessionId || !Number.isFinite(seq)) {
    throw new Error('用法：node scripts/dev.mjs read <session_id> <seq>');
  }
  const { db } = openConfiguredDb(flags.db ?? DEFAULTS.db);
  const service = makeService(db, flags);
  try {
    console.log(String((await service.read(sessionId, seq)) ?? '').trim());
  } finally {
    db.close();
  }
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case 'ingest':
      return commandIngest({ positional, flags });
    case 'query':
      return commandQuery({ positional, flags });
    case 'state':
      return commandState({ positional, flags });
    case 'history':
      return commandHistory({ positional, flags });
    case 'read':
      return commandRead({ positional, flags });
    default:
      console.log(HELP);
      throw new Error(`未知命令：${command}`);
  }
}

main().catch((error) => {
  console.error(`[dev] 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
