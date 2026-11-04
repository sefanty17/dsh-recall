import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb, migrate } from '../src/core/db.js';
import {
  attributeOf,
  chunkText,
  ftsPhrase,
  segmentCJK,
} from '../src/core/chunk.js';

const SOURCE = '这个项目统一使用 pnpm 作为包管理器，测试命令固定为 node --test。'.repeat(100).slice(0, 5000);

function assertSliceConsistent(source, chunks) {
  assert.ok(Array.isArray(chunks));
  for (const chunk of chunks) {
    assert.equal(typeof chunk.start, 'number');
    assert.equal(typeof chunk.end, 'number');
    assert.ok(Number.isInteger(chunk.start) && Number.isInteger(chunk.end));
    assert.ok(chunk.start >= 0 && chunk.end < source.length);
    assert.ok(chunk.start <= chunk.end);
    // 铁律：闭区间偏移必须能精确还原原文
    assert.equal(source.slice(chunk.start, chunk.end + 1), chunk.text);
    assert.ok(chunk.text.trim().length > 0, '不应产生纯空白块');
  }
}

test('chunkText: 5000 字中文切出多块，每块 slice 一致', () => {
  const chunks = chunkText(SOURCE);
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  assertSliceConsistent(SOURCE, chunks);

  // 块按原文顺序前进，且相邻块有重叠
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].start > chunks[i - 1].start, 'start 必须严格递增');
    assert.ok(chunks[i].start < chunks[i - 1].end + 1, '相邻块必须有重叠');
  }

  // 每块正文 ≤ maxChars，加上 overlap 不超过 maxChars + overlap
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 800 + 80, `chunk too long: ${chunk.text.length}`);
  }
});

test('chunkText: 无标点长文本按 maxChars 硬切，并带 80 字符重叠', () => {
  const source = '中'.repeat(2000);
  const chunks = chunkText(source);
  assert.equal(chunks.length, 3);
  assertSliceConsistent(source, chunks);

  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[0].end, 799); // 默认 maxChars = 800
  assert.equal(chunks[0].text.length, 800);
  assert.equal(chunks[1].start, chunks[0].end - 80 + 1); // 默认 overlap = 80
  assert.equal(chunks[1].end, 1599);
  assert.equal(chunks[2].end, source.length - 1);
});

test('chunkText: 自定义 maxChars / overlap', () => {
  const source = '测试句子。'.repeat(300); // 1500 字，全部带句号
  const chunks = chunkText(source, { maxChars: 100, overlap: 20 });
  assert.ok(chunks.length > 5);
  assertSliceConsistent(source, chunks);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 120, `chunk too long: ${chunk.text.length}`);
  }
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].start < chunks[i - 1].end + 1);
  }
});

test('chunkText: 短文本单块，边界是整段', () => {
  const source = '只有一句话。';
  const chunks = chunkText(source);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { start: 0, end: source.length - 1, text: source });
});

test('chunkText: 长段落优先在句号处断开', () => {
  const sentence = `${'字'.repeat(49)}。`;
  const source = sentence.repeat(25); // 1250 字，无换行
  const chunks = chunkText(source, { maxChars: 100, overlap: 0 });
  assertSliceConsistent(source, chunks);
  for (const chunk of chunks) {
    assert.ok(chunk.text.endsWith('。'), `应在句末断开: ${chunk.text.slice(-10)}`);
  }
});

test('chunkText: 空文本 / 纯空白返回 []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n\t \r\n '), []);
});

test('chunkText: 换行分段、CRLF 与多段合并都满足 slice 一致', () => {
  const source = '第一段内容。\r\n\r\n第二段内容，稍微长一点。\r\n第三段。';
  const chunks = chunkText(source);
  assertSliceConsistent(source, chunks);
  const joined = chunks.map((chunk) => chunk.text).join('|');
  assert.match(joined, /第一段内容/);
  assert.match(joined, /第三段/);
});

test('chunkText: 参数非法时抛错', () => {
  assert.throws(() => chunkText(null), TypeError);
  assert.throws(() => chunkText('abc', { maxChars: 0 }), RangeError);
  assert.throws(() => chunkText('abc', { overlap: -1 }), RangeError);
});

test('attributeOf: 事件类型 → 作者', () => {
  assert.equal(attributeOf({ type: 'user/message' }), 'user');
  assert.equal(attributeOf({ type: 'assistant/message' }), 'assistant');
  assert.equal(attributeOf({ type: 'tool/call' }), 'tool');
  assert.equal(attributeOf({ type: 'tool/result' }), 'tool');
  assert.equal(attributeOf({ type: 'system/message' }), 'system');
  assert.equal(attributeOf({ type: 'turn/start' }), 'system');
  assert.equal(attributeOf({}), 'system');
  assert.equal(attributeOf(null), 'system');
});

test('segmentCJK: 汉字两侧加空格，ASCII 不动，空白折叠', () => {
  assert.equal(segmentCJK('包管理器'), '包 管 理 器');
  assert.equal(segmentCJK('pnpm-lock 文件'), 'pnpm-lock 文 件');
  assert.equal(segmentCJK('  多个   空格\n换行  '), '多 个 空 格 换 行');
  assert.equal(segmentCJK(''), '');
  assert.equal(segmentCJK('node --test'), 'node --test');
});

test('ftsPhrase: 先切分再加引号并转义', () => {
  assert.equal(ftsPhrase('包管理器'), '"包 管 理 器"');
  assert.equal(ftsPhrase('a"b'), '"a""b"');
  assert.equal(ftsPhrase('启动'), '"启 动"');
});

test('SQLite FTS5: 逐字切分后中文短词（2 字）能命中', () => {
  const db = openDb(':memory:');
  try {
    assert.doesNotThrow(() => migrate(db), 'migrate 必须可重复执行');

    const insert = db.prepare('INSERT INTO span_fts (search_text, span_id) VALUES (?, ?)');
    insert.run(segmentCJK('这个项目作为包管理器使用的工具是 pnpm'), 1);
    insert.run(segmentCJK('服务启动需要两秒钟'), 2);
    insert.run(segmentCJK('测试命令固定用 node --test'), 3);
    insert.run('服务启动需要两秒钟', 4); // 未切分：unicode61 会把整句当一个词

    const hits = (term) => {
      const rows = db
        .prepare('SELECT span_id FROM span_fts WHERE span_fts MATCH ? ORDER BY span_id')
        .all(ftsPhrase(term));
      return rows.map((row) => Number(row.span_id));
    };

    assert.deepEqual(hits('包管理器'), [1]); // 3 字
    assert.deepEqual(hits('启动'), [2]); // 2 字
    assert.deepEqual(hits('测试'), [3]); // 2 字
    assert.deepEqual(hits('pnpm'), [1]);
    assert.deepEqual(hits('服务启动'), [2]); // 4 字
    assert.ok(!hits('启动').includes(4), '未切分的原文不应命中中文短词');
  } finally {
    db.close();
  }
});
