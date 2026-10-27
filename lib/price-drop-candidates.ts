import { ensureSchema, getSql } from "@/lib/db";
import { priceDropCandidateFilterSql } from "@/lib/candidate-filter";
import { mainUnitReasonSql, type MainUnitReason } from "@/lib/main-unit";
import {
  ACCESSORY_KEYWORDS,
  MIN_DROP_AMOUNT_YEN,
  MIN_DROP_RATE_PERCENT,
  MIN_PREVIOUS_PRICE_YEN,
  PRICE_DROP_PROMO_KEYWORDS,
} from "@/lib/price-drop-config";
import { shortenName } from "@/lib/price-drop-post";

// 値下げ経路の候補（候補条件をすべて通った商品）を取り出すクエリ。
// score ルート（上位 LIMIT 件）と、シリーズでまとめる投稿（全件）の両方で使う。

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

// 商品名に語の一覧のいずれかを含むかどうかの SQL 条件。NFKC で全角・半角をそろえ、大文字・小文字を区別しない。
// 語はすべて price-drop-config の定数で、外部入力は含まない。
function nameContainsAnySql(alias: string, keywords: string[]): string {
  return `(${keywords.map((keyword) => `normalize(${alias}.name, NFKC) ILIKE '%${keyword}%'`).join(" OR ")})`;
}

// 各商品の price_history から直近2回分（rn = 1 が今回、rn = 2 が前回）を取り出し、
// 値下げ額・値下げ率を計算する。履歴が1回分しかない商品は JOIN で落ちる。
// 値下げ率は前回との比較で出すが、候補にするのは今回の価格が過去 LOWEST_PRICE_WINDOW_DAYS 日の最安値
// （今回の記録を除く）を下回り、記録が MIN_RECORD_DAYS 日以上あり、比較した記録が MIN_COMPARED_DAYS 日分以上ある商品だけ。
// comparedDays は最安値の比較に使った記録の日数（JSTの日付で重複を除く）で、投稿文の「記録のある○日分の中で最安値」に使う。
// 最新の取得で在庫なし（availability = 0）の商品も除外する。availability を記録する前の取得（NULL）は在庫の有無が分からないため除外しない。
// 最新の取得が MAX_PRICE_AGE_HOURS 時間より古い商品、前回の取得日時がない商品（投稿文に日時を書けない）、候補から外す商品（priceDropCandidateFilterSql）は除外する。
// 値下げ率が MIN_DROP_RATE_PERCENT % 未満・値下げ額が MIN_DROP_AMOUNT_YEN 円未満の商品、商品名に PRICE_DROP_PROMO_KEYWORDS を含む商品も除外する。
// 本体でない商品は、アクセサリー（ACCESSORY_KEYWORDS）を除き、前回の価格が MIN_PREVIOUS_PRICE_YEN 円以上のものだけを残す。
// 「本体 > それ以外」、同じ区分の中では値下げ率の高い順に並べる。
// PostgreSQL では ORDER BY の式の中で SELECT の別名を使えないため、本体の判定は式をそのまま書く。
function scoreQuery(): string {
  return `
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
  ${mainUnitReasonSql("p")}                               AS "mainUnitReason"
FROM products p
JOIN ranked cur  ON cur.product_id  = p.id AND cur.rn  = 1
JOIN ranked prev ON prev.product_id = p.id AND prev.rn = 2
JOIN stats st    ON st.product_id   = p.id
WHERE cur.fetched_at > now() - make_interval(hours => ${MAX_PRICE_AGE_HOURS})
  AND prev.fetched_at IS NOT NULL
  AND cur.availability IS DISTINCT FROM 0
  AND prev.price - cur.price >= ${MIN_DROP_AMOUNT_YEN}
  AND (prev.price - cur.price) * 100.0 / prev.price >= ${MIN_DROP_RATE_PERCENT}
  AND NOT ${nameContainsAnySql("p", PRICE_DROP_PROMO_KEYWORDS)}
  AND (
    (${mainUnitReasonSql("p")}) IS NOT NULL
    OR (prev.price >= ${MIN_PREVIOUS_PRICE_YEN} AND NOT ${nameContainsAnySql("p", ACCESSORY_KEYWORDS)})
  )
  AND cur.price < st.lowest_price
  AND st.record_days >= ${MIN_RECORD_DAYS}
  AND st.compared_days >= ${MIN_COMPARED_DAYS}
  AND ${priceDropCandidateFilterSql("p")}
ORDER BY ((${mainUnitReasonSql("p")}) IS NOT NULL) DESC, (prev.price - cur.price) * 1.0 / prev.price DESC, "dropAmount" DESC, p.id ASC
`;
}

export type ScoredRow = {
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

// limit が null なら、候補条件を通った商品をすべて返す（シリーズでまとめるとき、上位だけでは種類の数を数えられないため）。
// 投稿に使える商品名を作れない商品（shortenName が null）も候補にしない。名前の整形は SQL では書けないため、
// クエリの後で絞り、上位 limit 件と totalFound は絞った後の件数で出す。
export async function getPriceDropProducts(limit: number | null): Promise<ScoredRow[]> {
  await ensureSchema();
  const rows = ((await getSql().query(scoreQuery())) as Omit<ScoredRow, "totalFound">[]).filter(
    (row) => shortenName(row.name, row.mainUnitReason !== null) !== null
  );
  return (limit === null ? rows : rows.slice(0, limit)).map((row) => ({ ...row, totalFound: rows.length }));
}
