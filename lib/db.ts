import { neon, Pool } from "@neondatabase/serverless";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('rakuten', 'amazon')),
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  image_url     TEXT,
  item_url      TEXT,
  affiliate_url TEXT,
  category      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS price_history (
  id             SERIAL PRIMARY KEY,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price          INTEGER,
  review_count   INTEGER,
  review_average REAL,
  rank           INTEGER,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_fetched
  ON price_history (product_id, fetched_at);

CREATE TABLE IF NOT EXISTS posts (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  platform      TEXT NOT NULL DEFAULT 'x' CHECK (platform = 'x'),
  post_text     TEXT NOT NULL,
  posted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS post_dedup (
  product_id     INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  last_posted_at TIMESTAMPTZ NOT NULL
);
`;

// dev のホットリロードでモジュールが再評価されても接続を使い回す
const globalForDb = globalThis as unknown as {
  neonSql?: ReturnType<typeof neon>;
  neonPool?: Pool;
  schemaReady?: Promise<void>;
};

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL が設定されていません");
  }
  return url;
}

// 単発のクエリ用（HTTPベース、トランザクション不要な読み書きに使う）
export function getSql() {
  if (!globalForDb.neonSql) {
    globalForDb.neonSql = neon(getConnectionString());
  }
  return globalForDb.neonSql;
}

// 複数クエリをまたぐトランザクション用（WebSocketベース）
export function getPool(): Pool {
  if (!globalForDb.neonPool) {
    globalForDb.neonPool = new Pool({ connectionString: getConnectionString() });
  }
  return globalForDb.neonPool;
}

// 初回アクセス時にテーブルがなければ作成する。import しただけでは接続しない。
export function ensureSchema(): Promise<void> {
  if (!globalForDb.schemaReady) {
    globalForDb.schemaReady = getPool()
      .query(SCHEMA)
      .then(() => undefined);
  }
  return globalForDb.schemaReady;
}
