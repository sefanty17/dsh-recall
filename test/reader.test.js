import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { decodeZstdFrames, listSessionFiles, readSessionFile } from '../src/core/reader.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(repoRoot, 'fixtures', 'sample-session', 'session.v3.jsonl.zstd');
const tmp = mkdtempSync(join(tmpdir(), 'dsh-recall-reader-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeSession(dir, name, lines) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const payload = lines.map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join('');
  writeFileSync(file, Buffer.from(payload, 'utf8'));
  return file;
}

function writeZstdSession(dir, name, frames) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const buffers = frames.map((frame) => zstdCompressSync(Buffer.from(frame, 'utf8')));
  writeFileSync(file, Buffer.concat(buffers));
  return file;
}

test('decodeZstdFrames: fixture 是 4 个完整帧，逐帧解压后拼出 header + 8 条事件', () => {
  const frames = decodeZstdFrames(readFileSync(fixture));
  assert.equal(frames.length, 4);
  assert.ok(frames.every((frame) => Buffer.isBuffer(frame)));

  const lines = Buffer.concat(frames).toString('utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 9);
  assert.equal(JSON.parse(lines[0]).type, 'session');
  assert.equal(lines.length - 1, 8);
});

test('readSessionFile: header 与 8 条事件，seq 从 0 递增', () => {
  const { header, events } = readSessionFile(fixture);
  assert.equal(header.type, 'session');
  assert.equal(header.version, 3);
  assert.equal(header.id, '0b7a3c21-5d4e-4f6a-9b8c-1d2e3f4a5b6c');
  assert.equal(header.cwd, 'D:\\personal_vibe\\dsh-recall');
  assert.equal(header.parentSession, null);
  assert.equal(header.origin, 'interactive');
  assert.equal(events.length, 8);
  assert.deepEqual(
    events.map((event) => event.seq),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(events.map((event) => event.type), [
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'user/message',
    'assistant/message',
    'tool/result',
    'system/message',
  ]);
  assert.ok(events.every((event) => Number.isInteger(event.time)));
});

test('readSessionFile: surfaceOp / sourceEventSeqs 原样保留', () => {
  const { events } = readSessionFile(fixture);
  const compressed = events.find((event) => event.seq === 5);
  assert.deepEqual(compressed.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 2 });
  assert.deepEqual(compressed.sourceEventSeqs, [0, 1, 2]);
  // 其他事件不应被塞入这两个字段
  assert.equal(events.filter((event) => 'surfaceOp' in event).length, 1);
});

test('readSessionFile: 纯 .jsonl 也能读', () => {
  const dir = join(tmp, 'plain');
  const file = writeSession(dir, 'session.v3.jsonl', [
    { type: 'session', version: 3, id: 'plain-1', cwd: 'D:\\plain' },
    { type: 'user/message', seq: 0, time: 1, data: { content: [] } },
    { type: 'tool/result', seq: 1, time: 2, data: { message: { content: [] }, error: null } },
  ]);
  const { header, events } = readSessionFile(file);
  assert.equal(header.id, 'plain-1');
  assert.equal(events.length, 2);
});

test('readSessionFile: JSON 坏行抛错，错误里带文件路径与行号', () => {
  const dir = join(tmp, 'bad-json');
  const file = writeSession(dir, 'session.v3.jsonl', [
    { type: 'session', version: 3, id: 'bad-json-1', cwd: 'D:\\bad' },
    '{"type":"user/message","seq":0,',
  ]);
  assert.throws(() => readSessionFile(file), (err) => {
    assert.match(err.message, /failed to parse session file/);
    assert.ok(err.message.includes(file), `message should include path: ${err.message}`);
    assert.match(err.message, /line 2/);
    return true;
  });
});

test('readSessionFile: zstd 帧头损坏抛错，错误里带文件路径', () => {
  const dir = join(tmp, 'bad-zstd');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.v3.jsonl.zstd');
  writeFileSync(file, Buffer.from('not a zstd frame at all'));
  assert.throws(() => readSessionFile(file), (err) => {
    assert.match(err.message, /failed to decode session file/);
    assert.ok(err.message.includes(file), `message should include path: ${err.message}`);
    return true;
  });
});

test('readSessionFile: 首行不是 session header 时抛错', () => {
  const dir = join(tmp, 'no-header');
  const file = writeSession(dir, 'session.v3.jsonl', [{ type: 'user/message', seq: 0, time: 1 }]);
  assert.throws(() => readSessionFile(file), /missing session header/);
});

test('listSessionFiles: fixture 目录返回 1 条，字段来自 header 与 stat', () => {
  const root = join(repoRoot, 'fixtures', 'sample-session');
  const files = listSessionFiles(root);
  assert.equal(files.length, 1);
  const [entry] = files;
  assert.equal(entry.id, '0b7a3c21-5d4e-4f6a-9b8c-1d2e3f4a5b6c');
  assert.equal(entry.cwd, 'D:\\personal_vibe\\dsh-recall');
  assert.equal(entry.path, fixture);
  const stat = statSync(fixture);
  assert.equal(entry.size, stat.size);
  assert.equal(entry.mtime, Math.floor(stat.mtimeMs));
});

test('listSessionFiles: 递归扫描、忽略无关文件、同目录优先 v3', () => {
  const root = join(tmp, 'scan');
  writeZstdSession(join(root, '--D-cwd-a--', 'session-aaa'), 'session.v3.jsonl.zstd', [
    `${JSON.stringify({ type: 'session', version: 3, id: 'aaa', cwd: 'D:\\a' })}\n`,
    `${JSON.stringify({ type: 'user/message', seq: 0, time: 1 })}\n`,
  ]);
  // 同目录旧版文件：应被 v3 压制，不能重复出现
  writeZstdSession(join(root, '--D-cwd-a--', 'session-aaa'), 'session.jsonl.zstd', [
    `${JSON.stringify({ type: 'session', version: 0, id: 'session-aaa', cwd: 'D:\\a' })}\n`,
  ]);
  writeSession(join(root, '--D-cwd-b--', 'bbb'), 'session.v3.jsonl', [
    { type: 'session', version: 3, id: 'bbb', cwd: 'D:\\b' },
    { type: 'user/message', seq: 0, time: 1 },
  ]);
  writeFileSync(join(root, '--D-cwd-b--', 'bbb', 'notes.md'), '# not a session\n');

  const files = listSessionFiles(root);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.id).sort(), ['aaa', 'bbb']);
  assert.deepEqual(files.map((file) => file.cwd).sort(), ['D:\\a', 'D:\\b']);
});

test('listSessionFiles: header 超过 4KB 时自动放大读取窗口', () => {
  const root = join(tmp, 'big-header');
  const header = {
    type: 'session',
    version: 3,
    id: 'big-header',
    cwd: 'D:\\big',
    padding: 'x'.repeat(9000),
  };
  writeZstdSession(join(root, 'session-big'), 'session.v3.jsonl.zstd', [
    `${JSON.stringify(header)}\n`,
    `${JSON.stringify({ type: 'user/message', seq: 0, time: 1 })}\n`,
  ]);
  const files = listSessionFiles(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].id, 'big-header');
  assert.equal(files[0].cwd, 'D:\\big');
});

test('listSessionFiles: 根目录不存在时抛错并带上路径', () => {
  const missing = join(tmp, 'does-not-exist');
  assert.throws(() => listSessionFiles(missing), (err) => {
    assert.ok(err.message.includes(missing), `message should include path: ${err.message}`);
    return true;
  });
});

test('listSessionFiles: 空目录返回 []', () => {
  const root = join(tmp, 'empty-root');
  mkdirSync(root, { recursive: true });
  assert.deepEqual(listSessionFiles(root), []);
});
