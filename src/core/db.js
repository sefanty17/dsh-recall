import { DatabaseSync } from 'node:sqlite';

/**
 * DDL 冻结：与 docs/design.md 第 3 节一致（只去掉开头的 PRAGMA，那两个 PRAGMA
 * 由 openDb 在打开连接时执行）。全部 IF NOT EXISTS，可重复执行。
 *
 * 体积极化（v0.1，经确认的唯一偏离）：units 不再存 search_text 列。
 * FTS5 的 unit_fts 内部已经保存了一份分词文本，units 里再存一份纯属浪费；
 * ingest 只把 segmentCJK(text) 写进 unit_fts。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  path          TEXT,
  cwd           TEXT,
  created_at    INTEGER,
  parent_id     TEXT,
  origin        TEXT,
  event_count   INTEGER NOT NULL DEFAULT 0,
  ingested_at   INTEGER,
  mtime         INTEGER                -- 接入层增量入库用，非 design.md 冻结字段
);

CREATE TABLE IF NOT EXISTS events (
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  time          INTEGER,
  surface       TEXT,                  -- current | shadowed | log-only | NULL
  author        TEXT,                  -- user | assistant | tool | system
  text          TEXT,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS units (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  start         INTEGER NOT NULL,      -- 字符偏移，闭区间
  end           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  time          INTEGER,
  author        TEXT,
  surface       TEXT,
  UNIQUE (session_id, seq, start)
);

CREATE VIRTUAL TABLE IF NOT EXISTS unit_fts USING fts5(
  search_text,
  unit_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS facts (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,
  value           TEXT,
  scope           TEXT NOT NULL,       -- cwd 绝对路径，或 'global'
  kind            TEXT NOT NULL,       -- decision|preference|constraint|failure|fact|todo
  status          TEXT NOT NULL DEFAULT 'active',  -- active|superseded|disputed|archived
  since           INTEGER,
  verified_at     INTEGER,
  drift           TEXT,                -- stable|slow|fast
  quote           TEXT,
  note            TEXT,                -- 模型自由文字，author 标注
  author          TEXT NOT NULL,       -- user|agent|rule
  verified        INTEGER NOT NULL DEFAULT 0,  -- 引文是否与原文逐字一致
  evidence_session TEXT,
  evidence_seq    INTEGER,
  span_start      INTEGER,
  span_end        INTEGER,
  supersedes      TEXT,                -- 旧 fact id
  superseded_by   TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_key_scope ON facts (key, scope, status);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS card_quotes (
  card_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  span_start  INTEGER,
  span_end    INTEGER,
  quote       TEXT,
  role        TEXT,                    -- decision|reason|constraint|context
  PRIMARY KEY (card_id, session_id, seq, role)
);

CREATE TABLE IF NOT EXISTS usage (
  ref_type    TEXT NOT NULL,           -- fact|card|unit
  ref_id      TEXT NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_used   INTEGER,
  PRIMARY KEY (ref_type, ref_id)
);
`;

/** 给已存在的旧库补列；CREATE TABLE IF NOT EXISTS 不会改已有表。 */
function ensureColumn(db, table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((info) => info.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** 建表 / 建索引。幂等，可重复执行。 */
export function migrate(db) {
  db.exec(DDL);
  // 接入层需要按文件 mtime 做增量；旧库在这里补齐。
  ensureColumn(db, 'sessions', 'mtime', 'INTEGER');
}

/** 打开索引库：WAL + 外键 + 自动建表。 */
export function openDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
