import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

const LIMIT = 10;

// 各商品の price_history から直近2回分（rn = 1 が今回、rn = 2 が前回）を取り出し、
// 値下げ額・値下げ率を計算する。履歴が1回分しかない商品は JOIN で落ちる。
// 値下げ額が0以下の商品は除外し、値下げ率の高い順に並べる。
const SCORE_QUERY = `
WITH ranked AS (
  SELECT
    product_id,
    price,
    review_count,
    review_average,
    ROW_NUMBER() OVER (
      PARTITION BY product_id ORDER BY fetched_at DESC, id DESC
    ) AS rn
  FROM price_history
)
SELECT
  p.id                                                   AS id,
  p.name                                                 AS name,
  cur.price                                              AS currentPrice,
  prev.price                                             AS previousPrice,
  prev.price - cur.price                                 AS dropAmount,
  ROUND((prev.price - cur.price) * 100.0 / prev.price, 1) AS dropRate,
  cur.review_average                                     AS reviewAverage,
  cur.review_count                                       AS reviewCount,
  p.affiliate_url                                        AS affiliateUrl,
  COUNT(*) OVER ()                                       AS totalFound
FROM products p
JOIN ranked cur  ON cur.product_id  = p.id AND cur.rn  = 1
JOIN ranked prev ON prev.product_id = p.id AND prev.rn = 2
WHERE prev.price - cur.price > 0
ORDER BY (prev.price - cur.price) * 1.0 / prev.price DESC, dropAmount DESC, p.id ASC
LIMIT ${LIMIT}
`;

type ScoredRow = {
  id: number;
  name: string;
  currentPrice: number;
  previousPrice: number;
  dropAmount: number;
  dropRate: number;
  reviewAverage: number | null;
  reviewCount: number | null;
  affiliateUrl: string | null;
  totalFound: number;
};

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = getDb().prepare(SCORE_QUERY).all() as ScoredRow[];

  return NextResponse.json({
    // 値下げが検知された商品の総数（上位 LIMIT 件に絞る前）
    totalFound: rows[0]?.totalFound ?? 0,
    count: rows.length,
    products: rows.map((row) => ({
      id: row.id,
      name: row.name,
      currentPrice: row.currentPrice,
      previousPrice: row.previousPrice,
      dropAmount: row.dropAmount,
      dropRate: row.dropRate,
      reviewAverage: row.reviewAverage,
      reviewCount: row.reviewCount,
      affiliateUrl: row.affiliateUrl,
    })),
  });
}
