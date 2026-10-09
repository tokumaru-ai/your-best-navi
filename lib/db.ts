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

-- 楽天APIの genreId（末端の子ジャンル）。本体ジャンルの商品を投稿候補で優先するために使う。
-- products は本列追加より前にデプロイ済みのため、IF NOT EXISTS で既存環境に retrofit する。
ALTER TABLE products ADD COLUMN IF NOT EXISTS genre_id INTEGER;

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

-- Xでバズっている投稿を保存し、AIで商品名を抽出するための下書きテーブル。
-- rakuten_product_id 等は、楽天でのマッチング結果（match-rakuten）を後から書き足す列。
-- posted_from_trending は、値下げとは別の投稿トリガーとして使われたかどうかのフラグ。
CREATE TABLE IF NOT EXISTS x_trending_posts (
  id                     SERIAL PRIMARY KEY,
  post_id                TEXT UNIQUE NOT NULL,
  text                   TEXT NOT NULL,
  author_id              TEXT,
  like_count             INTEGER,
  retweet_count          INTEGER,
  reply_count            INTEGER,
  quote_count            INTEGER,
  reaction_score         INTEGER,
  created_at             TIMESTAMPTZ,
  fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  extracted_product_name TEXT,
  extraction_confidence  TEXT CHECK (extraction_confidence IN ('high', 'low', 'none')),
  rakuten_product_id     INTEGER REFERENCES products(id) ON DELETE SET NULL,
  rakuten_checked_at     TIMESTAMPTZ,
  current_price          INTEGER,
  review_average         NUMERIC,
  review_count           INTEGER,
  posted_from_trending   BOOLEAN NOT NULL DEFAULT false
);

-- x_trending_posts は本テーブル追加より前にデプロイ済みのため、
-- CREATE TABLE IF NOT EXISTS だけでは既存環境に列が増えない。IF NOT EXISTS で安全に retrofit する。
ALTER TABLE x_trending_posts ADD COLUMN IF NOT EXISTS rakuten_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
ALTER TABLE x_trending_posts ADD COLUMN IF NOT EXISTS rakuten_checked_at TIMESTAMPTZ;
ALTER TABLE x_trending_posts ADD COLUMN IF NOT EXISTS current_price INTEGER;
ALTER TABLE x_trending_posts ADD COLUMN IF NOT EXISTS review_average NUMERIC;
ALTER TABLE x_trending_posts ADD COLUMN IF NOT EXISTS review_count INTEGER;
ALTER TABLE x_trending_posts ADD COLUMN IF NOT EXISTS posted_from_trending BOOLEAN NOT NULL DEFAULT false;

-- Cron（post-once）が実際に発火したか、成功・スキップ・失敗のどれだったかを
-- 値下げの有無やposts書き込みの成否によらず、必ず1回のみ残すためのログ。
CREATE TABLE IF NOT EXISTS cron_runs (
  id           SERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  trigger      TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  dry_run      BOOLEAN NOT NULL DEFAULT false,
  status       TEXT NOT NULL CHECK (status IN ('running', 'success', 'skipped', 'failed')),
  detail       TEXT,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL
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
