import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/core/db.js';
import { segmentCJK } from '../src/core/chunk.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVAL = join(ROOT, 'scripts', 'eval.mjs');
const SCOPE = 'D:\\personal_vibe\\baseline-demo';
const SESSION = 'sess-baseline-1';
const DAY = 86_400_000;
const T0 = Date.now();

const UNITS = [
  { seq: 30, text: '我们决定用 pnpm 作为包管理器', ageDays: 3 },
  // 注意：这里没有百分号，故意用来验证 LIKE 的 % 转义。
  { seq: 20, text: '测试要求 1000 覆盖率', ageDays: 2 },
  { seq: 10, text: '开发端口固定在 3000', ageDays: 1 },
];

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recall-baseline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedDb(file) {
  const db = openDb(file);
  db.prepare(
    'INSERT INTO sessions (id, path, cwd, created_at, event_count) VALUES (?, ?, ?, ?, 0)',
  ).run(SESSION, 'synthetic://baseline', SCOPE, T0 - 10 * DAY);
  for (const unit of UNITS) {
    const result = db.prepare(
      `INSERT INTO units (session_id, seq, start, end, text, time, author, surface)
       VALUES (?, ?, 0, ?, ?, ?, 'user', 'current')`,
    ).run(SESSION, unit.seq, unit.text.length - 1, unit.text, T0 - unit.ageDays * DAY);
    db.prepare('INSERT INTO unit_fts (search_text, unit_id) VALUES (?, ?)')
      .run(segmentCJK(unit.text), result.lastInsertRowid);
  }
  db.close();
}

/**
 * 一条测试覆盖三种检索：同一个 queries 文件分别用 --baseline ours /
 * grep / phrase 跑，各输出一行 [baseline] 指标（共三行），且口径一致。
 */
test('eval --baseline：ours / grep / phrase 跑同一个查询集，各输出一行指标', (t) => {
  const dir = makeTempDir(t);
  const dbPath = join(dir, 'baseline.db');
  seedDb(dbPath);

  const queries = [
    {
      query: '包管理器',
      scope: SCOPE,
      expect: { session_id: SESSION, seq: 30 },
    },
    {
      query: '测试',
      scope: SCOPE,
      expect: { session_id: SESSION, seq: 20 },
    },
    {
      // grep 必须把 % 当字面量：不转义的话会把 “1000 覆盖率” 也命中。
      query: '100%覆盖率',
      scope: SCOPE,
      expect: { session_id: SESSION, seq: 20 },
    },
  ];
  const queryFile = join(dir, 'queries.jsonl');
  writeFileSync(queryFile, `${queries.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  const lines = [];
  for (const mode of ['ours', 'grep', 'phrase']) {
    const run = spawnSync(
      process.execPath,
      [EVAL, '--queries', queryFile, '--db', dbPath, '--baseline', mode],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `${mode} 退出码非 0：${run.stderr}`);
    const matched = run.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[baseline]'));
    assert.equal(matched.length, 1, `${mode} 应输出一行 [baseline] 指标`);
    lines.push(matched[0]);
  }

  assert.equal(lines.length, 3, '三种模式共三行指标');
  assert.match(lines[0], /^\[baseline\] ours\s+Hit@1 100\.0% \(3\/3\) · MRR 1\.000/);
  assert.match(lines[1], /^\[baseline\] grep\s+Hit@1 66\.7% \(2\/3\) · MRR 0\.667/);
  assert.match(lines[2], /^\[baseline\] phrase\s+Hit@1 66\.7% \(2\/3\) · MRR 0\.667/);

  // 两条基线各只返回一条，命中与否决定平均条数；ours 是完整列表。
  assert.match(lines[0], /平均 1\.0 条/);
  assert.match(lines[1], /平均 0\.7 条/);
  assert.match(lines[2], /平均 0\.7 条/);
});
