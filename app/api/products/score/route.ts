import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";
import { priceDropCandidateFilterSql } from "@/lib/candidate-filter";
import { mainUnitReasonSql, type MainUnitReason } from "@/lib/main-unit";

const LIMIT = 10;
// 最新の取得がこの時間より古い商品は候補にしない。楽天の取得対象（ジャンル上位など）から外れた商品は
// 価格が更新されず、古い価格を「現在の値下げ価格」として投稿してしまうため。
const MAX_PRICE_AGE_HOURS = 24;
// 今回の価格が、この日数の間（今回の記録を除く）の最安値より低いときだけ値下げとみなす。
// 価格が一時的に上がって戻っただけ（別の商品構成の価格が返った場合など）を値下げと判定しないため。
const LOWEST_PRICE_WINDOW_DAYS = 30;
// 価格の記録がこの日数に満たない商品は、最安値の比較に足る記録がないため候補にしない
const MIN_RECORD_DAYS = 3;
// 最安値の比較に使った記録（過去 LOWEST_PRICE_WINDOW_DAYS 日、今回を除く）がこの日数分（JSTの日付、同じ日は1日）に
// 満たない商品も候補にしない。同じ日に何度も取得した記録（手動の dry-run など）で件数が水増しされないよう、日数で数える。
const MIN_COMPARED_DAYS = 3;

// 各商品の price_history から直近2回分（rn = 1 が今回、rn = 2 が前回）を取り出し、
// 値下げ額・値下げ率を計算する。履歴が1回分しかない商品は JOIN で落ちる。
// 値下げ率は前回との比較で出すが、候補にするのは今回の価格が過去 LOWEST_PRICE_WINDOW_DAYS 日の最安値
// （今回の記録を除く）を下回り、記録が MIN_RECORD_DAYS 日以上あり、比較した記録が MIN_COMPARED_DAYS 日分以上ある商品だけ。
// comparedDays は最安値の比較に使った記録の日数（JSTの日付で重複を除く）で、投稿文の「記録のある○日分の中で最安値」に使う。
// 最新の取得で在庫なし（availability = 0）の商品も除外する。availability を記録する前の取得（NULL）は在庫の有無が分からないため除外しない。
// 最新の取得が MAX_PRICE_AGE_HOURS 時間より古い商品、前回の取得日時がない商品（投稿文に日時を書けない）、値下げ額が0以下の商品、候補から外す商品（priceDropCandidateFilterSql）は除外し、「本体 > それ以外」、同じ区分の中では値下げ率の高い順に並べる。
// PostgreSQL では ORDER BY の式の中で SELECT の別名を使えないため、本体の判定は式をそのまま書く。
const SCORE_QUERY = `
WITH ranked AS (
  SELECT
    product_id,
    price,
    review_count,
    review_average,
    availability,
    fetched_at,
    ROW_NUMBER() OVER (
      PARTITION BY product_id ORDER BY fetched_at DESC, id DESC
    ) AS rn
  FROM price_history
),
stats AS (
  SELECT
    h.product_id,
    MIN(h.price) FILTER (
      WHERE h.rn > 1
        AND h.fetched_at >= cur.fetched_at - make_interval(days => ${LOWEST_PRICE_WINDOW_DAYS})
    ) AS lowest_price,
    COUNT(DISTINCT (h.fetched_at AT TIME ZONE 'Asia/Tokyo')::date) FILTER (
      WHERE h.rn > 1
        AND h.price IS NOT NULL
        AND h.fetched_at >= cur.fetched_at - make_interval(days => ${LOWEST_PRICE_WINDOW_DAYS})
    ) AS compared_days,
    EXTRACT(EPOCH FROM (cur.fetched_at - MIN(h.fetched_at))) / 86400 AS record_days
  FROM ranked h
  JOIN ranked cur ON cur.product_id = h.product_id AND cur.rn = 1
  GROUP BY h.product_id, cur.fetched_at
)
SELECT
  p.id                                                    AS id,
  p.name                                                  AS name,
  cur.price                                               AS "currentPrice",
  prev.price                                              AS "previousPrice",
  prev.price - cur.price                                  AS "dropAmount",
  ROUND((prev.price - cur.price) * 100.0 / prev.price, 1) AS "dropRate",
  cur.review_average                                      AS "reviewAverage",
  cur.review_count                                        AS "reviewCount",
  cur.fetched_at                                          AS "currentFetchedAt",
  prev.fetched_at                                         AS "previousFetchedAt",
  st.lowest_price                                         AS "lowestPrice",
  st.compared_days::int                                   AS "comparedDays",
  p.affiliate_url                                         AS "affiliateUrl",
  p.image_url                                             AS "imageUrl",
  ${mainUnitReasonSql("p")}                               AS "mainUnitReason",
  COUNT(*) OVER ()                                        AS "totalFound"
FROM products p
JOIN ranked cur  ON cur.product_id  = p.id AND cur.rn  = 1
JOIN ranked prev ON prev.product_id = p.id AND prev.rn = 2
JOIN stats st    ON st.product_id   = p.id
WHERE cur.fetched_at > now() - make_interval(hours => ${MAX_PRICE_AGE_HOURS})
  AND prev.fetched_at IS NOT NULL
  AND cur.availability IS DISTINCT FROM 0
  AND prev.price - cur.price > 0
  AND cur.price < st.lowest_price
  AND st.record_days >= ${MIN_RECORD_DAYS}
  AND st.compared_days >= ${MIN_COMPARED_DAYS}
  AND ${priceDropCandidateFilterSql("p")}
ORDER BY ((${mainUnitReasonSql("p")}) IS NOT NULL) DESC, (prev.price - cur.price) * 1.0 / prev.price DESC, "dropAmount" DESC, p.id ASC
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
  currentFetchedAt: Date;
  previousFetchedAt: Date;
  lowestPrice: number;
  comparedDays: number;
  affiliateUrl: string | null;
  imageUrl: string | null;
  mainUnitReason: MainUnitReason | null;
  totalFound: number;
};

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();
  const rows = (await getSql().query(SCORE_QUERY)) as ScoredRow[];

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
      // 投稿文に書く取得日時（直近2件の price_history）。JSON では ISO 文字列になる
      currentFetchedAt: row.currentFetchedAt,
      previousFetchedAt: row.previousFetchedAt,
      // 最安値の比較に使った記録（過去30日、今回を除く）の最安値と日数。今回の価格は lowestPrice より低い
      lowestPrice: row.lowestPrice,
      comparedDays: row.comparedDays,
      affiliateUrl: row.affiliateUrl,
      imageUrl: row.imageUrl,
      mainUnitReason: row.mainUnitReason,
    })),
  });
}
