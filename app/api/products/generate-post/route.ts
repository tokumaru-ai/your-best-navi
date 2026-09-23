import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { GET as getScoredProducts } from "../score/route";

const MODEL = "claude-haiku-4-5-20251001";

type ScoredProduct = {
  id: number;
  name: string;
  currentPrice: number;
  previousPrice: number;
  dropAmount: number;
  dropRate: number;
  reviewAverage: number | null;
  reviewCount: number | null;
  affiliateUrl: string | null;
  imageUrl: string | null;
};

const SYSTEM_PROMPT = `あなたは、値下げされた商品をX（旧Twitter）で紹介する投稿文を書くアシスタントです。
渡された商品データをもとに、投稿文を1つだけ作成してください。

# データの扱い（最重要）
- 商品名・現在価格・値下げ額・値下げ率・レビュー評価・レビュー件数は、必ず渡されたデータの値をそのまま使うこと。計算し直したり、丸めたり、言い換えたりしない。
- 渡されていない情報は書かない。在庫、セール期間、最安値、ランキング、スペック、口コミの内容などを推測で補わない。
- 商品名が長い場合は、渡された名前の先頭から意味の切れ目までを、書き換えずにそのまま抜粋してよい。名前に含まれるクーポン価格・割引額などの宣伝文句は、渡された価格データと食い違うため使わない。

# 禁止する表現
- 実際に使った体験を装う表現は禁止する。例:「使ってる」「愛用してる」「使ってみた」「買ってよかった」「おすすめ」といった断定的な推奨や体験談。
- 発見・共有のトーンで書くこと。例:「気になってた」「レビュー評価が高い」「値下げしてるっぽい」「チェックしてみて」。

# 形式
- 本文は100〜140文字程度（URLと#PRは含めない）。
- 絵文字は控えめに、多くても1つまで。
- 次の順で構成する。
  1. 本文
  2. 改行してアフィリエイトURL（渡されたURLを一字一句そのまま。改変・短縮しない）
  3. 改行して「#PR」（文末に必ず置く）
- 前置き、説明、引用符、コードブロックは付けず、投稿文だけを出力する。`;

function formatYen(value: number): string {
  return `${value.toLocaleString("ja-JP")}円`;
}

function buildUserPrompt(product: ScoredProduct): string {
  return [
    "次の商品について投稿文を作成してください。",
    "",
    `商品名: ${product.name}`,
    `現在価格: ${formatYen(product.currentPrice)}`,
    `前回価格: ${formatYen(product.previousPrice)}`,
    `値下げ額: ${formatYen(product.dropAmount)}`,
    `値下げ率: ${product.dropRate}%`,
    `レビュー評価: ${product.reviewAverage ?? "データなし"}`,
    `レビュー件数: ${product.reviewCount ?? "データなし"}件`,
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

  // 値下げ率トップ1件は、score ルートのロジックをそのまま呼び出して取得する
  const scoreRes = await getScoredProducts(request);
  if (!scoreRes.ok) {
    return NextResponse.json(
      { error: "値下げ商品の取得に失敗しました" },
      { status: 500 }
    );
  }
  const { products } = (await scoreRes.json()) as { products: ScoredProduct[] };
  const product = products[0];

  if (!product) {
    return NextResponse.json(
      { error: "値下げが検知された商品がありません" },
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
        `[generate-post] unusable output (stop_reason: ${message.stop_reason})`
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
    console.error(`[generate-post] Anthropic API error: ${detail}`);
    return NextResponse.json(
      { error: "投稿文の生成に失敗しました" },
      { status: 502 }
    );
  }
}
