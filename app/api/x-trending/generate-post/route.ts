import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import {
  getTrendingCandidates,
  MIN_REACTION_SCORE,
  type TrendingProduct,
} from "@/lib/trending-candidates";

const MODEL = "claude-haiku-4-5-20251001";

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

  // ?productId= が指定されればその候補を、なければ候補一覧の先頭を使う。
  // post-once は候補一覧から重複防止を通った商品を選び、productId を指定して呼び出す。
  const candidates = await getTrendingCandidates();
  const productIdParam = new URL(request.url).searchParams.get("productId");
  const product =
    productIdParam !== null
      ? candidates.find((c) => c.id === Number(productIdParam))
      : candidates[0];

  if (!product) {
    return NextResponse.json(
      {
        error:
          productIdParam !== null
            ? `productId=${productIdParam} はXトレンドの投稿候補に含まれていません`
            : `反応数が${MIN_REACTION_SCORE}以上の投稿候補となるXトレンド商品がありません`,
      },
      { status: 404 }
    );
  }

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
