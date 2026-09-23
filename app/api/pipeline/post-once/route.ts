import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";
import { GET as generatePost } from "../../products/generate-post/route";
import { GET as getScoredProducts } from "../../products/score/route";
import { POST as postToX } from "../../x-post/route";

type GeneratedProduct = {
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

type GeneratedPostResponse = {
  post: string;
  checks: { length: number; endsWithPR: boolean; containsAffiliateUrl: boolean };
  model: string;
  product: GeneratedProduct;
};

async function recordPost(params: {
  productId: number;
  postText: string;
  status: "success" | "failed";
  errorMessage?: string | null;
}) {
  await getSql().query(
    `
    INSERT INTO posts (product_id, platform, post_text, status, error_message)
    VALUES ($1, 'x', $2, $3, $4)
    `,
    [params.productId, params.postText, params.status, params.errorMessage ?? null]
  );
}

async function isRecentlyPosted(productId: number): Promise<boolean> {
  const rows = (await getSql().query(
    `
    SELECT 1 FROM post_dedup
    WHERE product_id = $1 AND last_posted_at > now() - interval '24 hours'
    `,
    [productId]
  )) as unknown[];
  return rows.length > 0;
}

async function upsertDedup(productId: number) {
  await getSql().query(
    `
    INSERT INTO post_dedup (product_id, last_posted_at)
    VALUES ($1, now())
    ON CONFLICT (product_id) DO UPDATE SET
      last_posted_at = now()
    `,
    [productId]
  );
}

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // 手動実行（x-api-secret）か、Vercel Cron（CRON_SECRET が自動付与する Authorization）のどちらかで認証する
  const isManualCall =
    !!secret && request.headers.get("x-api-secret") === secret;
  const isVercelCron =
    !!cronSecret &&
    request.headers.get("authorization") === `Bearer ${cronSecret}`;

  if (!isManualCall && !isVercelCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 下流のルートは x-api-secret を要求するため、Cron 経由でも使えるよう内部呼び出し用のリクエストを作る
  if (!secret) {
    return NextResponse.json(
      { error: "X_POST_SECRET が設定されていません" },
      { status: 500 }
    );
  }
  const internalRequest = new Request(request.url, {
    headers: { "x-api-secret": secret },
  });

  await ensureSchema();

  // a. 値下げ率トップ1件の投稿文を生成する
  const generateRes = await generatePost(internalRequest);

  if (generateRes.status === 404) {
    const body = await generateRes.json().catch(() => ({ error: "値下げが検知された商品がありません" }));
    return NextResponse.json(body, { status: 404 });
  }

  if (!generateRes.ok) {
    const errorBody = (await generateRes.json().catch(() => ({}))) as {
      error?: string;
      product?: GeneratedProduct;
    };
    const errorMessage = errorBody.error ?? "投稿文の生成に失敗しました";

    // エラー本文に商品情報が含まれない場合は score から改めて特定する
    let productId = errorBody.product?.id;
    if (productId === undefined) {
      const scoreRes = await getScoredProducts(internalRequest);
      if (scoreRes.ok) {
        const scoreBody = (await scoreRes.json()) as { products: GeneratedProduct[] };
        productId = scoreBody.products[0]?.id;
      }
    }

    if (productId !== undefined) {
      await recordPost({
        productId,
        postText: "",
        status: "failed",
        errorMessage,
      });
    }

    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }

  const { post, product } = (await generateRes.json()) as GeneratedPostResponse;

  // b. 24時間以内に投稿済みならスキップする
  if (await isRecentlyPosted(product.id)) {
    return NextResponse.json({
      skipped: true,
      reason: "24時間以内に投稿済み",
    });
  }

  // c. Xへ投稿する
  const xPostRequest = new Request(new URL("/api/x-post", request.url), {
    method: "POST",
    headers: {
      "x-api-secret": secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: post, imageUrl: product.imageUrl }),
  });

  let xPostOk: boolean;
  let xPostBody: { success?: boolean; tweet?: unknown; error?: string };
  try {
    const xPostRes = await postToX(xPostRequest);
    xPostOk = xPostRes.ok;
    xPostBody = await xPostRes.json();
  } catch (error) {
    xPostOk = false;
    xPostBody = { error: error instanceof Error ? error.message : String(error) };
  }

  // d. 投稿結果を記録する
  if (!xPostOk) {
    const errorMessage = xPostBody.error ?? "Xへの投稿に失敗しました";
    await recordPost({
      productId: product.id,
      postText: post,
      status: "failed",
      errorMessage,
    });
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }

  await recordPost({
    productId: product.id,
    postText: post,
    status: "success",
  });

  // e. 投稿成功時のみ dedup を更新する
  await upsertDedup(product.id);

  return NextResponse.json({
    posted: true,
    product,
    post,
    tweet: xPostBody.tweet,
  });
}
