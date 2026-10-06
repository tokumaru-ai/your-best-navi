import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";

const MODEL = "claude-haiku-4-5-20251001";
// これ未満の反応数（いいね+リポスト*2+リプライ+引用*2）の投稿は、
// 「話題になっている」根拠として弱いため、投稿対象として選ばない
const MIN_REACTION_SCORE = 5;

type TrendingProduct = {
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

const SYSTEM_PROMPT = `あなたは、X（旧Twitter）で話題になっている商品をXで紹介する投稿文を書くアシスタントです。
渡された商品データをもとに、投稿文を1つだけ作成してください。

# データの扱い（最重要）
- 商品名・現在価格・レビュー評価・レビュー件数・元投稿のいいね数・リポスト数は、必ず渡されたデータの値をそのまま使うこと。計算し直したり、丸めたり、言い換えたりしない。
- 渡されていない情報は書かない。在庫、セール期間、ランキング、スペック、口コミの内容などを推測で補わない。
- 商品名が長い場合は、渡された名前の先頭から意味の切れ目までを、書き換えずにそのまま抜粋してよい。名前に含まれるクーポン価格・割引額などの宣伝文句は、渡された価格データと食い違うため使わない。
- 今回の紹介の根拠は「値下げ」ではなく「Xで話題になっている（反応数が多い）」ことである。「値下げ」「安くなった」「セール中」という表現は使わない。

# 禁止する表現
- 実際に使った体験を装う表現は禁止する。例:「使ってる」「愛用してる」「使ってみた」「買ってよかった」「おすすめ」といった断定的な推奨や体験談。
- 発見・共有のトーンで書くこと。例:「Xで話題になってた」「いいねがたくさん集まってる」「みんな気になってるみたい」「チェックしてみて」。

# 形式
- 本文は80〜110文字程度（URL・ハッシュタグ・#PRは含めない）。ハッシュタグを追加した分、以前より短めにしている。
- 絵文字は控えめに、多くても1つまで。
- 次の順で構成する。
  1. 本文
  2. 改行してアフィリエイトURL（渡されたURLを一字一句そのまま。改変・短縮しない）
  3. 改行して「#Xトレンド」（固定のハッシュタグ。必ずこの文字列のまま追加する）
  4. 改行して「#PR」（文末に必ず置く）
- 前置き、説明、引用符、コードブロックは付けず、投稿文だけを出力する。`;

function formatYen(value: number): string {
  return `${value.toLocaleString("ja-JP")}円`;
}

function buildUserPrompt(product: TrendingProduct): string {
  return [
    "次の商品について投稿文を作成してください。",
    "",
    `商品名: ${product.name}`,
    `現在価格: ${product.currentPrice !== null ? formatYen(product.currentPrice) : "データなし"}`,
    `レビュー評価: ${product.reviewAverage ?? "データなし"}`,
    `レビュー件数: ${product.reviewCount ?? "データなし"}件`,
    `元投稿のいいね数: ${product.likeCount ?? "データなし"}`,
    `元投稿のリポスト数: ${product.retweetCount ?? "データなし"}`,
    `アフィリエイトURL: ${product.affiliateUrl}`,
  ].join("\n");
}

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY が設定されていません" },
      { status: 500 }
    );
  }

  await ensureSchema();

  // 楽天でマッチ済み（rakuten_product_id あり）かつ、まだXトレンド発の投稿に使われていない行を
  // 反応数が高い順に1件だけ取る
  const rows = (await getSql().query(
    `
    SELECT
      t.id AS trending_post_id,
      t.like_count, t.retweet_count, t.reaction_score,
      t.current_price, t.review_average, t.review_count,
      p.id AS product_id, p.name, p.affiliate_url, p.image_url
    FROM x_trending_posts t
    JOIN products p ON p.id = t.rakuten_product_id
    WHERE t.rakuten_product_id IS NOT NULL
      AND t.posted_from_trending = false
      AND t.reaction_score >= $1
    ORDER BY t.reaction_score DESC NULLS LAST
    LIMIT 1
    `,
    [MIN_REACTION_SCORE]
  )) as CandidateRow[];

  const row = rows[0];
  if (!row) {
    return NextResponse.json(
      {
        error: `反応数が${MIN_REACTION_SCORE}以上の投稿候補となるXトレンド商品がありません`,
      },
      { status: 404 }
    );
  }

  const product: TrendingProduct = {
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
  };

  if (!product.affiliateUrl) {
    return NextResponse.json(
      { error: "対象商品に affiliate_url がありません", product },
      { status: 422 }
    );
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(product) }],
    });

    const post = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();

    if (message.stop_reason === "max_tokens" || !post) {
      console.error(
        `[x-trending/generate-post] unusable output (stop_reason: ${message.stop_reason})`
      );
      return NextResponse.json(
        { error: "投稿文の生成に失敗しました" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      post,
      // ルールが守られているかの簡易チェック（ブロックはせず、確認用に返す）
      checks: {
        length: post.length,
        endsWithPR: post.endsWith("#PR"),
        containsAffiliateUrl: post.includes(product.affiliateUrl),
      },
      model: message.model,
      product,
    });
  } catch (error) {
    // SDK のエラー本文はキーを含まないが、クライアントには詳細を返さない
    const detail =
      error instanceof Anthropic.APIError
        ? `${error.status ?? "connection"} ${error.message}`
        : String(error);
    console.error(`[x-trending/generate-post] Anthropic API error: ${detail}`);
    return NextResponse.json(
      { error: "投稿文の生成に失敗しました" },
      { status: 502 }
    );
  }
}
