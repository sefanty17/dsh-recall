import { DatabaseSync } from 'node:sqlite';

/**
 * v3 DDL：只保留 span / topic 地图层需要的 6 张表。
 * 与 docs/design-v2.md 第 2 节一致（冻结）。全部 IF NOT EXISTS，可重复执行。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS spans (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  type          TEXT NOT NULL,        -- decision | operation | narrative
  text          TEXT NOT NULL,        -- 模型概括（允许改写，但必须能被 evidence 支撑）
  turns         TEXT NOT NULL,        -- JSON 数组，如 [7,9]
  evidence      TEXT NOT NULL,        -- JSON 数组 [{session_id, seq, turn}]
  rationale_from TEXT,                -- user | assistant | reasoning | tool
  batch_id      TEXT,                 -- 哪次整理产出
  session_ids   TEXT,                 -- JSON 数组
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS spans_scope ON spans (scope, type);

CREATE VIRTUAL TABLE IF NOT EXISTS span_fts USING fts5(
  search_text, span_id UNINDEXED, tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS span_vectors (
  span_id   TEXT PRIMARY KEY,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vec       BLOB NOT NULL            -- float32 little-endian
);

CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  file        TEXT NOT NULL,
  span_ids    TEXT NOT NULL,         -- JSON 数组
  content_hash TEXT,
  updated_at  INTEGER NOT NULL,
  UNIQUE (scope, slug)
);

CREATE TABLE IF NOT EXISTS topic_vectors (
  topic_id TEXT PRIMARY KEY,
  model    TEXT NOT NULL,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS curations (
  id         TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  session_id TEXT,
  from_seq   INTEGER,
  to_seq     INTEGER,
  spans      INTEGER,
  topics     INTEGER,
  created_at INTEGER NOT NULL
);
`;

/**
 * v1 遗留表：全是派生数据，可从会话文件重建。
 * 老库升级时直接删除；新库上这些 DROP 是空操作。逐条 try/catch，
 * 保证某张表不存在 / 被占用时不影响其余迁移。
 */
const LEGACY_TABLES = [
  'facts',
  'units',
  'unit_fts',
  'events',
  'sessions',
  'cards',
  'card_quotes',
  'usage',
];

/** 建表 / 建索引，并清掉 v1 遗留表。幂等，可重复执行。 */
export function migrate(db) {
  db.exec(DDL);
  for (const table of LEGACY_TABLES) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch {
      // 老库锁定 / 视图依赖等极端情况：跳过即可，不影响 v2 表可用
    }
  }
}

/** 打开索引库：WAL + 外键 + 自动建表。 */
export function openDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
