import { getSql } from "@/lib/db";

// これ未満の反応数（いいね+リポスト*2+リプライ+引用*2）の投稿は、
// 「話題になっている」根拠として弱いため、投稿対象として選ばない
export const MIN_REACTION_SCORE = 5;

// 投稿候補として返す商品数の上限。post-once はこの上位から順に重複防止を確認する。
export const TRENDING_CANDIDATE_LIMIT = 10;

export type TrendingProduct = {
  id: number;
  trendingPostId: number;
  name: string;
  currentPrice: number | null;
  reviewAverage: number | null;
  reviewCount: number | null;
  affiliateUrl: string | null;
  imageUrl: string | null;
  likeCount: number | null;
  retweetCount: number | null;
  reactionScore: number | null;
};

// pg は NUMERIC 列を精度保持のため文字列で返す（INTEGER/REALとは違い自動で number にならない）
type CandidateRow = {
  trending_post_id: number;
  like_count: number | null;
  retweet_count: number | null;
  reaction_score: number | null;
  current_price: number | null;
  review_average: string | null;
  review_count: number | null;
  product_id: number;
  name: string;
  affiliate_url: string | null;
  image_url: string | null;
};

// 楽天でマッチ済みかつ、まだXトレンド発の投稿に使われていない行を商品（rakuten_product_id）単位で集約し、
// 各商品で反応数が最大の行を代表として、反応数の高い順に上位 TRENDING_CANDIDATE_LIMIT 件を返す。
// 同じ商品に複数のバズ投稿がマッチしていても、候補としては1件にまとめる。
export async function getTrendingCandidates(): Promise<TrendingProduct[]> {
  const rows = (await getSql().query(
    `
    SELECT * FROM (
      SELECT DISTINCT ON (t.rakuten_product_id)
        t.id AS trending_post_id,
        t.like_count, t.retweet_count, t.reaction_score,
        t.current_price, t.review_average, t.review_count,
        p.id AS product_id, p.name, p.affiliate_url, p.image_url
      FROM x_trending_posts t
      JOIN products p ON p.id = t.rakuten_product_id
      WHERE t.rakuten_product_id IS NOT NULL
        AND t.posted_from_trending = false
        AND t.reaction_score >= $1
      ORDER BY t.rakuten_product_id, t.reaction_score DESC, t.id ASC
    ) per_product
    ORDER BY reaction_score DESC NULLS LAST, product_id ASC
    LIMIT $2
    `,
    [MIN_REACTION_SCORE, TRENDING_CANDIDATE_LIMIT]
  )) as CandidateRow[];

  return rows.map((row) => ({
    id: row.product_id,
    trendingPostId: row.trending_post_id,
    name: row.name,
    currentPrice: row.current_price,
    reviewAverage: row.review_average !== null ? Number(row.review_average) : null,
    reviewCount: row.review_count,
    affiliateUrl: row.affiliate_url,
    imageUrl: row.image_url,
    likeCount: row.like_count,
    retweetCount: row.retweet_count,
    reactionScore: row.reaction_score,
  }));
}
