const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP = 80;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * SQLite unicode61 会把连续汉字当成一个整词，检索前需要按字切开。
 * 返回的文本只用于 FTS 索引，不用于展示。
 */
export function segmentCJK(text) {
  let out = '';
  for (const ch of text) out += CJK.test(ch) ? ` ${ch} ` : ch;
  return out.replace(/\s+/g, ' ').trim();
}

/** 构造 FTS5 phrase：先按字切分，再转义双引号。 */
export function ftsPhrase(term) {
  const seg = segmentCJK(term).replaceAll('"', '""');
  return `"${seg}"`;
}

// ---------------------------------------------------------------------------
// 切分
// ---------------------------------------------------------------------------

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '．', '…']);
const CLOSERS = new Set(['」', '』', '）', ')', '】', '》', '”', '’', ']', '}', '"', "'"]);

function isSpaceCode(code) {
  return (
    code === 0x20 || // space
    code === 0x09 || // tab
    code === 0x0a || // \n
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d || // \r
    code === 0xa0 || // nbsp
    code === 0x3000 || // 全角空格
    code === 0xfeff
  );
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 把 [start, end] 两端的空白削掉；整段空白返回 null。 */
function trimBounds(text, start, end) {
  while (start <= end && isSpaceCode(text.charCodeAt(start))) start += 1;
  while (end >= start && isSpaceCode(text.charCodeAt(end))) end -= 1;
  return start <= end ? [start, end] : null;
}

function emitHardSlices(text, start, end, maxChars, push) {
  let cursor = start;
  while (cursor <= end) {
    let cut = Math.min(cursor + maxChars - 1, end);
    if (cut < end && isHighSurrogate(text.charCodeAt(cut))) cut -= 1;
    if (cut < cursor) cut = cursor;
    push(cursor, cut);
    cursor = cut + 1;
  }
}

function emitSentence(text, start, end, maxChars, push) {
  if (end - start + 1 <= maxChars) {
    push(start, end);
    return;
  }
  emitHardSlices(text, start, end, maxChars, push);
}

/** 一行超长时先按句号/问号/叹号/分号切，仍超长再硬切。 */
function splitLongLine(text, start, end, maxChars, push) {
  let segmentStart = start;
  let i = start;
  while (i <= end) {
    const ch = text[i];
    let boundary = SENTENCE_END.has(ch);
    if (!boundary && ch === '.') {
      // 英文句点只在后面是空白/行尾时才当句末，避免切开 1.5 / v0.1
      boundary = i === end || isSpaceCode(text.charCodeAt(i + 1));
    }
    if (!boundary) {
      i += 1;
      continue;
    }
    let segmentEnd = i;
    // 吞掉连续的句末符号与收尾引号/括号
    for (;;) {
      if (segmentEnd >= end) break;
      const next = text[segmentEnd + 1];
      if (SENTENCE_END.has(next) || next === '.' || CLOSERS.has(next)) {
        segmentEnd += 1;
        continue;
      }
      break;
    }
    emitSentence(text, segmentStart, segmentEnd, maxChars, push);
    segmentStart = segmentEnd + 1;
    i = segmentEnd + 1;
  }
  if (segmentStart <= end) emitSentence(text, segmentStart, end, maxChars, push);
}

/** 切成「原子段」：换行分段 → 超长按句切 → 仍超长硬切。空白段丢弃。 */
function atomize(text, maxChars) {
  const atoms = [];
  const push = (start, end) => {
    const bounds = trimBounds(text, start, end);
    if (bounds) atoms.push({ start: bounds[0], end: bounds[1] });
  };

  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    if (!atEnd && text.charCodeAt(i) !== 0x0a) continue;
    const lineEnd = i - 1;
    if (lineEnd >= lineStart) {
      if (lineEnd - lineStart + 1 <= maxChars) push(lineStart, lineEnd);
      else splitLongLine(text, lineStart, lineEnd, maxChars, push);
    }
    lineStart = i + 1;
  }
  return atoms;
}

/** 把原子段贪心打包成块，续块向前多带 overlap 个字符。 */
function packAtoms(atoms, maxChars, overlap) {
  const spans = [];
  let current = null;
  for (const atom of atoms) {
    if (current && atom.end - current.bodyStart + 1 > maxChars) {
      spans.push({ start: current.start, end: current.end });
      current = null;
    }
    if (current) {
      current.end = atom.end;
      continue;
    }
    let start = atom.start;
    const prev = spans[spans.length - 1];
    if (prev && overlap > 0) start = Math.max(prev.start + 1, atom.start - overlap, 0);
    current = { bodyStart: atom.start, start, end: atom.end };
  }
  if (current) spans.push({ start: current.start, end: current.end });
  return spans;
}

/** 字符偏移闭区间；text === source.slice(start, end + 1) 恒成立。 */
export function chunkText(text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('chunkText(text, opts): text must be a string');
  const maxChars = Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS);
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new RangeError('chunkText(text, opts): maxChars must be a positive integer');
  }
  let overlap = Math.floor(opts.overlap ?? DEFAULT_OVERLAP);
  if (!Number.isFinite(overlap) || overlap < 0) {
    throw new RangeError('chunkText(text, opts): overlap must be a non-negative integer');
  }
  overlap = Math.min(overlap, maxChars - 1);

  if (text.length === 0) return [];

  const chunks = [];
  for (const span of packAtoms(atomize(text, maxChars), maxChars, overlap)) {
    let { start, end } = span;
    if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1;
    if (end < text.length - 1 && isHighSurrogate(text.charCodeAt(end))) end -= 1;
    if (end < start) continue;
    const piece = text.slice(start, end + 1);
    if (piece.trim() === '') continue;
    if (chunks.length > 0 && start <= chunks[chunks.length - 1].start) continue;
    chunks.push({ start, end, text: piece });
  }
  return chunks;
}

/** 事件作者：user / assistant / tool / system。 */
export function attributeOf(event) {
  switch (event?.type) {
    case 'user/message':
      return 'user';
    case 'assistant/message':
      return 'assistant';
    case 'tool/call':
    case 'tool/result':
      return 'tool';
    default:
      return 'system';
  }
}
