import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(process.cwd(), "data", "app.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL CHECK (source IN ('rakuten', 'amazon')),
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  image_url     TEXT,
  item_url      TEXT,
  affiliate_url TEXT,
  category      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS price_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price          INTEGER,
  review_count   INTEGER,
  review_average REAL,
  rank           INTEGER,
  fetched_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_fetched
  ON price_history (product_id, fetched_at);
`;

// dev のホットリロードでモジュールが再評価されても接続を使い回す
const globalForDb = globalThis as unknown as { sqlite?: Database.Database };

// 初回アクセス時に接続を開き、テーブルがなければ作成する。
// import しただけではファイルを作らない（next build 中の副作用を避けるため）。
export function getDb(): Database.Database {
  if (!globalForDb.sqlite) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);

    globalForDb.sqlite = db;
  }

  return globalForDb.sqlite;
}
