import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/core/db.js';
import {
  resolveEmbeddingConfig,
  embedTexts,
  cosine,
  saveSpanVectors,
  loadSpanVectors,
  saveTopicVectors,
  loadTopicVectors,
} from '../src/core/vectors.js';

function makeDb(t) {
  const db = openDb(':memory:');
  t.after(() => {
    if (typeof db.close === 'function') db.close();
  });
  return db;
}

function closeTo(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
}

// ---------------------------------------------------------------------------
// cosine
// ---------------------------------------------------------------------------

test('cosine：同向 / 正交 / 反向 / 零向量 / 长度不等', () => {
  closeTo(cosine([1, 2, 3], [1, 2, 3]), 1);
  closeTo(cosine([1, 0], [0, 1]), 0);
  closeTo(cosine([1, 0], [-1, 0]), -1);
  closeTo(cosine([1, 1], [2, 2]), 1);
  closeTo(cosine([3, 4], [6, 8]), 1);

  assert.equal(cosine([0, 0], [1, 0]), 0, '零向量不能产生 NaN');
  assert.equal(cosine([1, 2], [1, 2, 3]), 0, '长度不等返回 0');
  assert.equal(cosine([], []), 0);
  assert.equal(cosine(null, [1]), 0);
  assert.equal(cosine(undefined, undefined), 0);

  // Float32Array 与普通数组等价
  closeTo(cosine(Float32Array.from([1, 0]), [1, 0]), 1);
  // 结果不越界
  const sim = cosine([1e-8, 0], [1e-8, 0]);
  assert.ok(sim >= -1 && sim <= 1);
});

// ---------------------------------------------------------------------------
// resolveEmbeddingConfig
// ---------------------------------------------------------------------------

test('resolveEmbeddingConfig：默认 none，不产生任何联网依赖', () => {
  const cfg = resolveEmbeddingConfig({});
  assert.equal(cfg.backend, 'none');
  assert.equal(cfg.model, 'bge-small-zh-v1.5');
  assert.equal(cfg.dim, 0);
  assert.equal(cfg.available, false);
  assert.equal(cfg.url, null);
});

test('resolveEmbeddingConfig：http 需要 URL，model / dim 可配', () => {
  const missingUrl = resolveEmbeddingConfig({ DSH_RECALL_EMBED_BACKEND: 'http' });
  assert.equal(missingUrl.backend, 'http');
  assert.equal(missingUrl.available, false, '没有 URL 不可用');

  const cfg = resolveEmbeddingConfig({
    DSH_RECALL_EMBED_BACKEND: 'HTTP',
    DSH_RECALL_EMBED_URL: 'http://127.0.0.1:11434/v1',
    DSH_RECALL_EMBED_MODEL: 'bge-m3',
  });
  assert.equal(cfg.backend, 'http');
  assert.equal(cfg.available, true);
  assert.equal(cfg.model, 'bge-m3');
  assert.equal(cfg.dim, 1024);
  assert.equal(cfg.url, 'http://127.0.0.1:11434/v1');

  const explicitDim = resolveEmbeddingConfig({
    DSH_RECALL_EMBED_BACKEND: 'http',
    DSH_RECALL_EMBED_URL: 'http://x/v1',
    DSH_RECALL_EMBED_DIM: '768',
  });
  assert.equal(explicitDim.dim, 768);
});

test('resolveEmbeddingConfig：local 且包未安装时 available=false；非法 backend 归 none', () => {
  const local = resolveEmbeddingConfig({ DSH_RECALL_EMBED_BACKEND: 'local' });
  assert.equal(local.backend, 'local');
  assert.equal(local.model, 'bge-small-zh-v1.5');
  assert.equal(typeof local.available, 'boolean');
  assert.equal(local.dim, 512);

  assert.equal(resolveEmbeddingConfig({ DSH_RECALL_EMBED_BACKEND: 'openai' }).backend, 'none');
  assert.equal(resolveEmbeddingConfig().backend, 'none', '默认读 process.env，也应是 none');
});

test('embedTexts：backend=none 返回 null；空数组不发请求', async () => {
  assert.equal(await embedTexts(['你好'], { backend: 'none' }), null);
  assert.equal(await embedTexts(['你好'], {}), null);
  assert.deepEqual(await embedTexts([], { backend: 'http', url: 'http://x/v1' }), []);
});

test('embedTexts：http 后端按 OpenAI 兼容格式请求，key 只进 Authorization', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DSH_RECALL_EMBED_KEY;
  process.env.DSH_RECALL_EMBED_KEY = 'sk-test-secret';

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify({
        object: 'list',
        // 故意乱序，验证按 index 排序
        data: [
          { object: 'embedding', index: 1, embedding: [3, 4] },
          { object: 'embedding', index: 0, embedding: [1, 2] },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DSH_RECALL_EMBED_KEY;
    else process.env.DSH_RECALL_EMBED_KEY = originalKey;
  });

  const vectors = await embedTexts(['第一段', '第二段'], {
    backend: 'http',
    model: 'bge-small-zh-v1.5',
    url: 'http://fake.local/v1',
  });

  assert.equal(vectors.length, 2);
  assert.ok(vectors[0] instanceof Float32Array);
  assert.deepEqual([...vectors[0]], [1, 2]);
  assert.deepEqual([...vectors[1]], [3, 4]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://fake.local/v1/embeddings');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-test-secret');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'bge-small-zh-v1.5');
  assert.deepEqual(body.input, ['第一段', '第二段']);
});

test('embedTexts：http 失败时抛错，且错误信息里不出现 key', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('server says sk-test-secret is bad', { status: 500 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => embedTexts(['x'], {
      backend: 'http',
      url: 'http://fake.local/v1',
      apiKey: 'sk-test-secret',
    }),
    (err) => {
      assert.match(err.message, /HTTP 500/);
      assert.ok(!err.message.includes('sk-test-secret'), '错误信息不能带 key');
      return true;
    },
  );
});

test('embedTexts：local 包未安装时抛明确错误，不崩进程', async (t) => {
  const available = resolveEmbeddingConfig({ DSH_RECALL_EMBED_BACKEND: 'local' }).available;
  if (available) {
    t.skip('@huggingface/transformers 已安装，跳过未安装分支');
    return;
  }
  await assert.rejects(
    () => embedTexts(['x'], { backend: 'local', model: 'bge-small-zh-v1.5' }),
    /local embedding backend requires @huggingface\/transformers/,
  );
});

// ---------------------------------------------------------------------------
// span_vectors BLOB 往返
// ---------------------------------------------------------------------------

test('saveSpanVectors / loadSpanVectors：float32 小端 BLOB 往返', (t) => {
  const db = makeDb(t);

  const saved = saveSpanVectors(db, [
    { span_id: 'sp_a', model: 'test-model', dim: 999, vec: [1.5, -2, 0] },
    { span_id: 'sp_b', model: 'test-model', vec: Float32Array.from([0, 1]) },
  ]);
  assert.equal(saved, 2);

  const rows = loadSpanVectors(db, ['sp_a', 'sp_b']);
  assert.equal(rows.length, 2);
  const a = rows.find((row) => row.span_id === 'sp_a');
  assert.equal(a.model, 'test-model');
  assert.equal(a.dim, 3, 'dim 由实际向量长度推出，忽略传入的 999');
  assert.ok(a.vec instanceof Float32Array);
  assert.equal(a.vec.length, 3);
  assert.equal(a.vec[0], 1.5);
  assert.equal(a.vec[1], -2);
  assert.equal(a.vec[2], 0);

  const b = rows.find((row) => row.span_id === 'sp_b');
  assert.equal(b.dim, 2);
  assert.deepEqual([...b.vec], [0, 1]);

  // 原始 BLOB 必须是 4 字节小端 float32（node:sqlite 返回 Uint8Array）
  const raw = Buffer.from(
    db.prepare('SELECT vec FROM span_vectors WHERE span_id = ?').get('sp_a').vec,
  );
  assert.equal(raw.length, 12);
  assert.equal(raw.readFloatLE(0), 1.5);
  assert.equal(raw.readFloatLE(4), -2);

  saveSpanVectors(db, [{ span_id: 'sp_one', model: 'm', vec: [1] }]);
  const one = Buffer.from(
    db.prepare('SELECT vec FROM span_vectors WHERE span_id = ?').get('sp_one').vec,
  );
  assert.deepEqual([...one], [0x00, 0x00, 0x80, 0x3f], '1.0 的小端字节序');
});

test('saveSpanVectors：同 id 覆盖写；空输入 / 空 id 安全', (t) => {
  const db = makeDb(t);
  assert.equal(saveSpanVectors(db, []), 0);
  assert.equal(saveSpanVectors(db, [{ span_id: '', vec: [1] }]), 0);
  assert.equal(saveSpanVectors(db, [{ span_id: 'sp_a', vec: [] }]), 0);

  saveSpanVectors(db, [{ span_id: 'sp_a', model: 'm1', vec: [1, 0] }]);
  saveSpanVectors(db, [{ span_id: 'sp_a', model: 'm2', vec: [0, 1] }]);
  const rows = loadSpanVectors(db, ['sp_a']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'm2');
  assert.deepEqual([...rows[0].vec], [0, 1]);
});

test('loadSpanVectors：空 ids 返回空、未知 id 返回空、省略 ids 返回全部', (t) => {
  const db = makeDb(t);
  saveSpanVectors(db, [
    { span_id: 'sp_a', model: 'm', vec: [1, 0] },
    { span_id: 'sp_b', model: 'm', vec: [0, 1] },
  ]);
  assert.deepEqual(loadSpanVectors(db, []), []);
  assert.deepEqual(loadSpanVectors(db, ['sp_nope']), []);
  assert.equal(loadSpanVectors(db).length, 2);
});

// ---------------------------------------------------------------------------
// topic_vectors
// ---------------------------------------------------------------------------

test('saveTopicVectors / loadTopicVectors：按 scope join 过滤', (t) => {
  const db = makeDb(t);
  const insertTopic = db.prepare(
    `INSERT INTO topics (id, scope, slug, title, description, file, span_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTopic.run('tp_1', 'D:\\proj\\a', 'topic-a', 'A', 'a', '/tmp/a.md', '[]', 1);
  insertTopic.run('tp_2', 'D:\\proj\\b', 'topic-b', 'B', 'b', '/tmp/b.md', '[]', 2);

  const saved = saveTopicVectors(db, [
    { topic_id: 'tp_1', model: 'm', vec: [1, 2, 3] },
    { topic_id: 'tp_2', model: 'm', vec: [4, 5, 6] },
  ]);
  assert.equal(saved, 2);

  const a = loadTopicVectors(db, 'D:\\proj\\a');
  assert.equal(a.length, 1);
  assert.equal(a[0].topic_id, 'tp_1');
  assert.equal(a[0].dim, 3);
  assert.deepEqual([...a[0].vec], [1, 2, 3]);

  assert.equal(loadTopicVectors(db).length, 2);
  assert.deepEqual(loadTopicVectors(db, 'D:\\proj\\missing'), []);
});
