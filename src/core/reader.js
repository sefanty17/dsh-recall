import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216;
const SESSION_FILE_RE = /\.jsonl(?:\.zstd)?$/;
const HEADER_READ_STEPS = [4096, 65536];

// ---------------------------------------------------------------------------
// zstd 多帧
// ---------------------------------------------------------------------------

/**
 * 按 DSH 的帧扫描算法把首尾相接的 zstd 帧切开（不解释内容）。
 * 尾部残缺帧会被丢弃；帧头损坏直接抛错。
 */
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break; // 尾部残缺
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) break;
    const d = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = d >>> 6;
    const singleSegment = (d & 32) !== 0;
    const checksum = (d & 4) !== 0;
    const dictFlag = d & 3;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictBytes + contentSizeBytes;
    for (;;) {
      const h = buffer.readUIntLE(offset, 3);
      offset += 3;
      const last = (h & 1) !== 0;
      const type = (h >>> 1) & 3;
      const size = h >>> 3;
      offset += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) offset += 4;
    frames.push(buffer.subarray(start, offset));
  }
  return frames;
}

/** 逐帧解压，返回每帧解压后的字节。 */
export function decodeZstdFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return scanFrames(buf).map((frame) => zstdDecompressSync(frame));
}

// ---------------------------------------------------------------------------
// 会话文件
// ---------------------------------------------------------------------------

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseRecords(text, filePath) {
  const lines = text.split('\n');
  const records = [];
  const lineNos = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (raw.trim() === '') continue;
    try {
      records.push(JSON.parse(raw));
    } catch (err) {
      throw new Error(
        `failed to parse session file "${filePath}" at line ${i + 1}: ${err.message}`,
        { cause: err },
      );
    }
    lineNos.push(i + 1);
  }
  if (records.length === 0) return { header: null, events: [] };
  const header = records[0];
  if (!header || header.type !== 'session') {
    throw new Error(
      `missing session header in "${filePath}" at line ${lineNos[0]}: ` +
        `expected {"type":"session",...}, got ${JSON.stringify(header?.type ?? null)}`,
    );
  }
  return { header, events: records.slice(1) };
}

/** 读一个会话：支持 `session.v3.jsonl.zstd`（多帧 zstd）和纯 `.jsonl`。 */
export function readSessionFile(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (err) {
    throw new Error(`failed to read session file "${filePath}": ${err.message}`, { cause: err });
  }

  let text;
  if (filePath.endsWith('.zstd')) {
    let frames;
    try {
      frames = decodeZstdFrames(buffer);
    } catch (err) {
      throw new Error(`failed to decode session file "${filePath}": ${err.message}`, { cause: err });
    }
    if (frames.length === 0) throw new Error(`empty session file "${filePath}": no complete zstd frame`);
    text = stripBom(Buffer.concat(frames).toString('utf8'));
  } else {
    text = stripBom(buffer.toString('utf8'));
  }

  const { header, events } = parseRecords(text, filePath);
  if (!header) throw new Error(`empty session file "${filePath}"`);
  return { header, events };
}

// ---------------------------------------------------------------------------
// 扫描 sessionsRoot
// ---------------------------------------------------------------------------

function readPrefix(filePath, length) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function firstHeaderRecord(filePath, chunk) {
  let text;
  if (filePath.endsWith('.zstd')) {
    const frames = decodeZstdFrames(chunk);
    if (frames.length === 0) throw new Error('no complete zstd frame');
    text = stripBom(frames[0].toString('utf8'));
  } else {
    text = stripBom(chunk.toString('utf8'));
  }
  const firstLine = text.split('\n', 1)[0].replace(/\r$/, '');
  if (firstLine.trim() === '') throw new Error('empty header');
  const header = JSON.parse(firstLine);
  if (!header || header.type !== 'session') throw new Error('first record is not a session header');
  return header;
}

/**
 * 只读文件开头（必要时逐步放大）解析 header，避免为了拿 cwd 解压整份会话。
 */
function readHeader(filePath, size) {
  const steps = [...HEADER_READ_STEPS, size];
  const tried = new Set();
  let cause = null;
  for (const step of steps) {
    const length = Math.min(step, size);
    if (length <= 0 || tried.has(length)) continue;
    tried.add(length);
    try {
      return firstHeaderRecord(filePath, readPrefix(filePath, length));
    } catch (err) {
      cause = err;
    }
  }
  throw new Error(`failed to read session header "${filePath}": ${cause?.message ?? 'unknown error'}`, {
    cause,
  });
}

function fileRank(name) {
  if (name === 'session.v3.jsonl.zstd') return 0;
  if (name.endsWith('.zstd')) return 1;
  return 2;
}

function fallbackId(dir) {
  return basename(dir).replace(/^session-/, '');
}

/**
 * 递归扫描 sessionsRoot，返回会话文件清单。
 * 同一个会话目录里若同时有 v3 / 旧版文件，只取优先的那一个（v3 > 其他 .zstd > .jsonl），
 * 避免同一会话被重复 ingest。按 mtime 升序返回。
 */
export function listSessionFiles(sessionsRoot) {
  let rootStat;
  try {
    rootStat = statSync(sessionsRoot);
  } catch (err) {
    throw new Error(`failed to scan sessions root "${sessionsRoot}": ${err.message}`, { cause: err });
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`sessions root is not a directory: "${sessionsRoot}"`);
  }

  const candidates = [];
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`failed to scan session directory "${dir}": ${err.message}`, { cause: err });
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && SESSION_FILE_RE.test(entry.name)) {
        candidates.push({ dir, path: full, name: entry.name });
      }
    }
  }

  const byDir = new Map();
  for (const candidate of candidates) {
    const prev = byDir.get(candidate.dir);
    if (!prev || fileRank(candidate.name) < fileRank(prev.name)) byDir.set(candidate.dir, candidate);
  }

  const files = [];
  for (const candidate of byDir.values()) {
    let stat;
    try {
      stat = statSync(candidate.path);
    } catch (err) {
      throw new Error(`failed to stat session file "${candidate.path}": ${err.message}`, { cause: err });
    }
    const header = readHeader(candidate.path, stat.size);
    files.push({
      id: typeof header.id === 'string' && header.id !== '' ? header.id : fallbackId(candidate.dir),
      path: candidate.path,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
    });
  }
  files.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  return files;
}
