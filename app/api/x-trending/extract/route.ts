import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";

const MODEL = "claude-haiku-4-5-20251001";
// 1回の実行で処理する件数の上限（関数のタイムアウトを避けるため）
const BATCH_SIZE = 20;

const SYSTEM_PROMPT = `あなたは、X（旧Twitter）の投稿本文から、話題になっている商品名を抽出するアシスタントです。
渡された投稿本文を読み、商品名を1つだけ抽出してください。

# ルール
- 具体的な商品名・型番・ブランド名+商品カテゴリなどから、商品が特定できる場合のみ抽出する。
- 投稿に商品名が書かれていない場合、日常の出来事の感想など商品と無関係な場合は、productName は必ず null にする。
- 複数の商品が書かれている場合は、最も中心的に話題にされている1つだけを選ぶ。
- 確信度は次の基準で判定する。
  - "high": 商品名・ブランド名が投稿文にそのまま明記されている
  - "low": ジャンルや特徴から商品をある程度推測できるが、名称が明記されていない、または曖昧
  - "none": 商品を特定できない（このとき productName は必ず null）
- 出力は、次のJSON形式のみ。前置き・説明・コードブロックの記号（\`\`\`）は一切付けない。
{"productName": "商品名の文字列 または null", "confidence": "high" または "low" または "none"}`;

type ExtractResult = {
  productName: string | null;
  confidence: "high" | "low" | "none";
};

type PendingRow = {
  id: number;
  post_id: string;
  text: string;
};

function parseExtractResult(rawText: string): ExtractResult | null {
  // 念のため、コードブロック記号が付いてしまった場合を剥がす
  const cleaned = rawText.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<ExtractResult>;
    if (
      (parsed.productName === null || typeof parsed.productName === "string") &&
      (parsed.confidence === "high" || parsed.confidence === "low" || parsed.confidence === "none")
    ) {
      // confidence が none なのに productName が入っている場合は矛盾なので、安全側に倒して null にする
      const productName = parsed.confidence === "none" ? null : parsed.productName ?? null;
      return { productName, confidence: parsed.confidence };
    }
    return null;
  } catch {
    return null;
  }
}

async function extractOne(
  client: Anthropic,
  text: string
): Promise<{ result: ExtractResult } | { apiError: string }> {
  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });

    const rawText = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();

    const parsed = parseExtractResult(rawText);
    if (!parsed) {
      // モデルは応答したが、期待した形式で返さなかった場合。
      // API自体は失敗していないので「処理済み・確信度なし」として扱い、無限リトライを防ぐ。
      console.error(`[x-trending/extract] unparsable output: ${rawText.slice(0, 200)}`);
      return { result: { productName: null, confidence: "none" } };
    }
    return { result: parsed };
  } catch (error) {
    const detail =
      error instanceof Anthropic.APIError
        ? `${error.status ?? "connection"} ${error.message}`
        : String(error);
    return { apiError: detail };
  }
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

  // 「未処理」は extraction_confidence IS NULL で判定する。
  // extracted_product_name IS NULL だけだと、確信度 "none"（商品なしと判定済み）の行も
  // 毎回再処理の対象になってしまうため。バズった投稿から順に処理する。
  const pending = (await getSql().query(
    `
    SELECT id, post_id, text
    FROM x_trending_posts
    WHERE extraction_confidence IS NULL
    ORDER BY reaction_score DESC NULLS LAST, fetched_at ASC
    LIMIT $1
    `,
    [BATCH_SIZE]
  )) as PendingRow[];

  const client = new Anthropic();
  const results: {
    postId: string;
    productName?: string | null;
    confidence?: string;
    error?: string;
  }[] = [];

  for (const row of pending) {
    const outcome = await extractOne(client, row.text);

    if ("apiError" in outcome) {
      console.error(`[x-trending/extract] post_id=${row.post_id} failed: ${outcome.apiError}`);
      results.push({ postId: row.post_id, error: outcome.apiError });
      continue; // extraction_confidence を更新しない＝次回また未処理として拾われる
    }

    await getSql().query(
      `
      UPDATE x_trending_posts
      SET extracted_product_name = $2, extraction_confidence = $3
      WHERE id = $1
      `,
      [row.id, outcome.result.productName, outcome.result.confidence]
    );

    results.push({
      postId: row.post_id,
      productName: outcome.result.productName,
      confidence: outcome.result.confidence,
    });
  }

  return NextResponse.json({
    pending: pending.length,
    processed: results.filter((r) => !r.error).length,
    extracted: results.filter((r) => r.productName).length,
    errors: results.filter((r) => r.error).length,
    results,
  });
}
