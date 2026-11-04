// 入库 worker：把同步的 readSessionFile + ingestSession 搬出主线程。
// 只有一个职责：收一批 session 文件，逐个入库，回传结果；自己持有独立 SQLite 连接。
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../core/db.js';
import { ingestSession } from '../core/ingest.js';
import { listSessionFiles, readSessionFile } from '../core/reader.js';

let db;
let updateSessionMtime;
try {
  db = openDb(workerData.dbPath);
  // 主线程可能同时在读写；WAL 下等锁而不是立刻 SQLITE_BUSY。
  db.exec('PRAGMA busy_timeout = 10000');
  updateSessionMtime = db.prepare('UPDATE sessions SET mtime = ? WHERE id = ?');
} catch (error) {
  parentPort?.postMessage({
    type: 'fatal',
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

function ingestOne(job) {
  const startedAt = Date.now();
  try {
    const { header, events } = readSessionFile(job.path);
    const result = ingestSession(db, { header, events });
    // 只有成功入库才记 mtime；失败的下轮会重试。
    updateSessionMtime.run(Math.trunc(Number(job.mtime) || 0), job.id);
    return {
      id: job.id,
      units: Number(result?.units ?? 0),
      facts: Number(result?.facts ?? 0),
      ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - startedAt,
    };
  }
}

parentPort?.on('message', (message) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'close') {
    try {
      db.close();
    } catch {
      // ignore
    }
    parentPort?.postMessage({ type: 'closed' });
    return;
  }

  if (message.type === 'scan') {
    if (message.scanId == null) return;
    try {
      const files = listSessionFiles(message.sessionsRoot ?? workerData.sessionsRoot);
      parentPort?.postMessage({ type: 'scan-done', scanId: message.scanId, files });
    } catch (error) {
      parentPort?.postMessage({
        type: 'scan-failed',
        scanId: message.scanId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (message.type !== 'batch') return;
  const jobs = Array.isArray(message.jobs) ? message.jobs : [];
  const startedAt = Date.now();
  const results = jobs.map(ingestOne);
  parentPort?.postMessage({
    type: 'batch-done',
    batchId: message.batchId,
    results,
    ms: Date.now() - startedAt,
  });
});
