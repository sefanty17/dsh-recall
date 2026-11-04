import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRerankScore,
  rerankDocuments,
  resolveRerankConfig,
} from '../src/core/rerank.js';

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} ≈ ${expected}`);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function documentSet() {
  return [
    { id: 'sp_a', text: 'TTS 情感参数走独立配置文件' },
    { id: 'sp_b', text: 'TTS 情感参数导致显存溢出' },
    { id: 'sp_c', text: 'TTS 情感参数与降 batch 的决定' },
  ];
}

// ---------------------------------------------------------------------------
// resolveRerankConfig
// ---------------------------------------------------------------------------

test('resolveRerankConfig：默认 none，不联网也不加载模型', () => {
  assert.deepEqual(resolveRerankConfig({}), {
    backend: 'none',
    model: 'Xenova/bge-reranker-base',
    url: null,
    topN: 0,
    available: false,
  });
  assert.equal(resolveRerankConfig().backend, 'none', '默认读 process.env，也应是 none');
});

test('resolveRerankConfig：http 需要 url + key，默认 BAAI/bge-reranker-v2-m3', () => {
  const noUrl = resolveRerankConfig({ DSH_RECALL_RERANK_BACKEND: 'HTTP' });
  assert.equal(noUrl.backend, 'http', 'backend 大小写不敏感');
  assert.equal(noUrl.model, 'BAAI/bge-reranker-v2-m3');
  assert.equal(noUrl.available, false, '没有 url 不可用');

  const noKey = resolveRerankConfig({
    DSH_RECALL_RERANK_BACKEND: 'http',
    DSH_RECALL_RERANK_URL: 'https://api.siliconflow.cn/v1',
  });
  assert.equal(noKey.available, false, '没有 key 不可用');

  const cfg = resolveRerankConfig({
    DSH_RECALL_RERANK_BACKEND: 'http',
    DSH_RECALL_RERANK_URL: 'https://api.siliconflow.cn/v1',
    DSH_RECALL_RERANK_KEY: 'sk-test-secret',
    DSH_RECALL_RERANK_MODEL: 'BAAI/bge-reranker-v2-m3',
    DSH_RECALL_RERANK_TOP_N: '5',
  });
  assert.equal(cfg.available, true);
  assert.equal(cfg.url, 'https://api.siliconflow.cn/v1');
  assert.equal(cfg.topN, 5);
  // 配置对象里没有 key 字段，序列化也不应带出
  assert.equal(cfg.key, undefined);
  assert.ok(!JSON.stringify(cfg).includes('sk-test-secret'));

  const viaOpenAiKey = resolveRerankConfig({
    DSH_RECALL_RERANK_BACKEND: 'http',
    DSH_RECALL_RERANK_URL: 'https://api.jina.ai/v1',
    OPENAI_API_KEY: 'sk-openai',
  });
  assert.equal(viaOpenAiKey.available, true, 'OPENAI_API_KEY 可兜底');
});

test('resolveRerankConfig：local 默认 Xenova/bge-reranker-base；非法 backend 归 none', () => {
  const local = resolveRerankConfig({ DSH_RECALL_RERANK_BACKEND: 'local' });
  assert.equal(local.backend, 'local');
  assert.equal(local.model, 'Xenova/bge-reranker-base');
  assert.equal(typeof local.available, 'boolean');
  assert.equal(local.url, null);

  const backup = resolveRerankConfig({
    DSH_RECALL_RERANK_BACKEND: 'local',
    DSH_RECALL_RERANK_MODEL: 'jinaai/jina-reranker-v2-base-multilingual',
  });
  assert.equal(backup.model, 'jinaai/jina-reranker-v2-base-multilingual');

  assert.equal(resolveRerankConfig({ DSH_RECALL_RERANK_BACKEND: 'jina' }).backend, 'none');
  assert.equal(resolveRerankConfig({ DSH_RECALL_RERANK_BACKEND: '' }).backend, 'none');
});

// ---------------------------------------------------------------------------
// normalizeRerankScore
// ---------------------------------------------------------------------------

test('normalizeRerankScore：0..1 透传，其余 sigmoid，非法值 0', () => {
  assert.equal(normalizeRerankScore(0), 0);
  assert.equal(normalizeRerankScore(0.42), 0.42);
  assert.equal(normalizeRerankScore(1), 1);
  closeTo(normalizeRerankScore(2), sigmoid(2));
  closeTo(normalizeRerankScore(-2), sigmoid(-2));
  assert.equal(normalizeRerankScore('0.7'), 0.7, '数字字符串可接受');

  assert.equal(normalizeRerankScore(Number.NaN), 0);
  assert.equal(normalizeRerankScore(undefined), 0);
  assert.equal(normalizeRerankScore(null), 0);
  assert.equal(normalizeRerankScore(''), 0);

  for (const raw of [-1e9, -3, -0.5, 0, 0.5, 1, 3, 1e9]) {
    const score = normalizeRerankScore(raw);
    assert.ok(score >= 0 && score <= 1, `score=${score} 越界`);
  }
});

// ---------------------------------------------------------------------------
// rerankDocuments（注入假 rerankFn，不联网）
// ---------------------------------------------------------------------------

test('rerankDocuments：注入 rerankFn，按重排分降序并归一化到 0..1', async () => {
  const documents = documentSet();
  const seen = [];
  const table = { sp_a: 0.2, sp_b: 2, sp_c: -2 };
  const rerankFn = async ({ query, documents: docs }) => {
    seen.push(query);
    return docs.map((doc) => ({ id: doc.id, score: table[doc.id] }));
  };

  const result = await rerankDocuments({ query: '  TTS 情感参数  ', documents, rerankFn });

  assert.deepEqual(seen, ['TTS 情感参数'], 'query 去空白后传给后端');
  assert.deepEqual(result.map((item) => item.id), ['sp_b', 'sp_a', 'sp_c']);
  closeTo(result[0].score, sigmoid(2));
  assert.equal(result[1].score, 0.2);
  closeTo(result[2].score, sigmoid(-2));
  for (const item of result) {
    assert.ok(item.score >= 0 && item.score <= 1);
  }
});

test('rerankDocuments：topN 截断，默认 0 不截断', async () => {
  const documents = documentSet();
  const rerankFn = async ({ documents: docs }) => docs.map((doc, index) => ({
    id: doc.id,
    score: index / 10,
  }));

  const all = await rerankDocuments({ query: 'q', documents, rerankFn });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((item) => item.id), ['sp_c', 'sp_b', 'sp_a']);

  const top2 = await rerankDocuments({
    query: 'q',
    documents,
    rerankFn,
    cfg: { backend: 'none', topN: 2 },
  });
  assert.deepEqual(top2.map((item) => item.id), ['sp_c', 'sp_b']);

  assert.deepEqual(await rerankDocuments({ query: 'q', documents: [], rerankFn }), []);
});

test('rerankDocuments：兼容后端原生 results[index]/relevance_score 形状', async () => {
  const documents = documentSet();
  const rerankFn = async () => ({
    results: [
      { index: 2, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.1 },
      { index: 1, relevance_score: 0.5 },
    ],
  });

  const result = await rerankDocuments({ query: 'q', documents, rerankFn });
  assert.deepEqual(result.map((item) => item.id), ['sp_c', 'sp_b', 'sp_a']);
  assert.equal(result[0].score, 0.9);
});

test('rerankDocuments：http 后端 POST {url}/rerank，key 只进 Authorization', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      results: [
        { index: 0, score: 0.1 },
        { index: 1, relevance_score: 0.9 },
        { index: 2, score: 0.9 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const cfg = {
    backend: 'http',
    url: 'http://fake.local/v1/',
    model: 'BAAI/bge-reranker-v2-m3',
    apiKey: 'sk-test-secret',
  };
  const result = await rerankDocuments({ query: 'TTS 情感参数', documents: documentSet(), cfg });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://fake.local/v1/rerank', '末尾斜杠不重复');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-test-secret');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'BAAI/bge-reranker-v2-m3');
  assert.equal(body.query, 'TTS 情感参数');
  assert.deepEqual(body.documents, documentSet().map((doc) => doc.text));
  assert.equal(body.top_n, 3);
  assert.ok(!calls[0].options.body.includes('sk-test-secret'), 'key 不能进 body');

  // 分数相同按原顺序（稳定排序）
  assert.deepEqual(result.map((item) => item.id), ['sp_b', 'sp_c', 'sp_a']);
  assert.equal(result[0].score, 0.9);

  // url 已经以 /rerank 结尾时不再补一段
  await rerankDocuments({
    query: 'q',
    documents: [{ id: 'sp_a', text: 'x' }],
    cfg: { ...cfg, url: 'http://fake.local/v1/rerank' },
  });
  assert.equal(calls[1].url, 'http://fake.local/v1/rerank');
});

test('rerankDocuments：http 失败 / 超时 → null（不抛，也不泄露 key）', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response('bad key sk-test-secret', { status: 500 });
  const failed = await rerankDocuments({
    query: 'q',
    documents: documentSet(),
    cfg: { backend: 'http', url: 'http://fake.local/v1', apiKey: 'sk-test-secret' },
  });
  assert.equal(failed, null);

  // 永不返回、只等 abort 的 fetch：验证 8 秒超时逻辑（这里把超时调小到 50ms）
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('timeout')));
  });
  const timedOut = await rerankDocuments({
    query: 'q',
    documents: documentSet(),
    cfg: { backend: 'http', url: 'http://fake.local/v1', apiKey: 'sk-test-secret', timeoutMs: 50 },
  });
  assert.equal(timedOut, null);

  // 缺 url 也走 null 分支，不把配置错误抛给检索主链路
  const missingUrl = await rerankDocuments({
    query: 'q',
    documents: documentSet(),
    cfg: { backend: 'http', apiKey: 'sk-test-secret' },
  });
  assert.equal(missingUrl, null);
});

test('rerankDocuments：backend=none → null（调用方保持原顺序）', async () => {
  const result = await rerankDocuments({
    query: 'q',
    documents: documentSet(),
    cfg: { backend: 'none' },
  });
  assert.equal(result, null);
});

test('rerankDocuments：local 未安装 @huggingface/transformers → 明确错误', async (t) => {
  const available = resolveRerankConfig({ DSH_RECALL_RERANK_BACKEND: 'local' }).available;
  if (available) {
    t.skip('@huggingface/transformers 已安装，跳过未安装分支');
    return;
  }
  await assert.rejects(
    () => rerankDocuments({
      query: 'q',
      documents: documentSet(),
      cfg: { backend: 'local', model: 'Xenova/bge-reranker-base' },
    }),
    /local rerank backend requires @huggingface\/transformers/,
  );
});
