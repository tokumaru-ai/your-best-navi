import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";
import { GET as fetchRakutenPrices } from "../../rakuten/fetch/route";
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

type RunStatus = "success" | "skipped" | "failed";

type ImageCheck = {
  url: string;
  fetchOk: boolean;
  mimeType?: string;
  bytes?: number;
  error?: string;
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

// cron_runs: 開始時に running で1行作り、終了時に必ず更新する。
// 「今日 Cron が発火したか」自体を、posts の書き込み有無によらず確認できるようにするためのログ。
async function startRun(trigger: "cron" | "manual", dryRun: boolean): Promise<number> {
  const rows = (await getSql().query(
    `
    INSERT INTO cron_runs (trigger, dry_run, status)
    VALUES ($1, $2, 'running')
    RETURNING id
    `,
    [trigger, dryRun]
  )) as { id: number }[];
  return rows[0].id;
}

async function finishRun(
  runId: number,
  status: RunStatus,
  detail?: string | null,
  productId?: number | null
): Promise<void> {
  await getSql().query(
    `
    UPDATE cron_runs
    SET finished_at = now(), status = $2, detail = $3, product_id = $4
    WHERE id = $1
    `,
    [runId, status, detail ?? null, productId ?? null]
  );
}

// dry-run 用: 画像URLの取得とcontent-typeの検証だけを行い、Xへは一切アクセスしない
// （client.v1.uploadMedia・client.v2.tweet のどちらも呼ばない）。
async function checkImage(imageUrl: string): Promise<ImageCheck> {
  try {
    const res = await fetch(imageUrl);
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();

    if (!res.ok) {
      return { url: imageUrl, fetchOk: false, error: `HTTP ${res.status}` };
    }
    if (!contentType || !contentType.startsWith("image/")) {
      return {
        url: imageUrl,
        fetchOk: false,
        error: `content-typeが不正です: ${contentType ?? "(なし)"}`,
      };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { url: imageUrl, fetchOk: true, mimeType: contentType, bytes: buffer.length };
  } catch (error) {
    return {
      url: imageUrl,
      fetchOk: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

  const dryRun =
    new URL(request.url).searchParams.get("dryRun") === "true" ||
    process.env.DRY_RUN === "true";
  const trigger: "cron" | "manual" = isVercelCron ? "cron" : "manual";

  const internalRequest = new Request(request.url, {
    headers: { "x-api-secret": secret },
  });

  await ensureSchema();

  const runId = await startRun(trigger, dryRun);
  // ハンドラ内のどの return / 例外が発生しても、finally で必ずこの内容を cron_runs に反映する
  let outcome: { status: RunStatus; detail?: string | null; productId?: number | null } = {
    status: "failed",
    detail: "ハンドラが outcome を設定せずに終了しました（想定外のパス）",
  };

  try {
    // 0. まず楽天の最新価格を取得・保存する。失敗しても値下げ検知・投稿処理は続行する
    try {
      const fetchRes = await fetchRakutenPrices(internalRequest);
      if (!fetchRes.ok) {
        const body = await fetchRes.json().catch(() => ({}));
        console.error(`[pipeline/post-once] rakuten/fetch failed: ${JSON.stringify(body)}`);
      }
    } catch (error) {
      console.error(
        `[pipeline/post-once] rakuten/fetch threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // a. 値下げ率トップ1件の投稿文を生成する
    const generateRes = await generatePost(internalRequest);

    if (generateRes.status === 404) {
      const body = (await generateRes
        .json()
        .catch(() => ({ error: "値下げが検知された商品がありません" }))) as { error?: string };
      outcome = { status: "skipped", detail: body.error ?? "値下げが検知された商品がありません" };
      return NextResponse.json({ ...body, dryRun }, { status: 404 });
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

      if (productId !== undefined && !dryRun) {
        await recordPost({
          productId,
          postText: "",
          status: "failed",
          errorMessage,
        });
      }

      outcome = { status: "failed", detail: errorMessage, productId: productId ?? null };
      return NextResponse.json({ error: errorMessage, dryRun }, { status: 500 });
    }

    const { post, product, checks } = (await generateRes.json()) as GeneratedPostResponse;

    // b. 24時間以内に投稿済みならスキップする（dry-run では検証を続けたいのでこのチェック自体を行わない）
    if (!dryRun && (await isRecentlyPosted(product.id))) {
      outcome = { status: "skipped", detail: "24時間以内に投稿済み", productId: product.id };
      return NextResponse.json({
        skipped: true,
        reason: "24時間以内に投稿済み",
      });
    }

    if (dryRun) {
      // 実際のXアクセス（uploadMedia・tweet）は一切行わず、画像取得までを検証する
      const image = product.imageUrl ? await checkImage(product.imageUrl) : null;

      outcome = {
        status: "success",
        detail: "dry-run: 実際の投稿は行っていません",
        productId: product.id,
      };
      return NextResponse.json({
        dryRun: true,
        wouldPost: true,
        product,
        post,
        checks,
        image,
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
      outcome = { status: "failed", detail: errorMessage, productId: product.id };
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }

    await recordPost({
      productId: product.id,
      postText: post,
      status: "success",
    });

    // e. 投稿成功時のみ dedup を更新する
    await upsertDedup(product.id);

    outcome = { status: "success", productId: product.id };
    return NextResponse.json({
      posted: true,
      product,
      post,
      tweet: xPostBody.tweet,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pipeline/post-once] unhandled error: ${message}`);
    outcome = { status: "failed", detail: message };
    return NextResponse.json({ error: "内部エラーが発生しました" }, { status: 500 });
  } finally {
    await finishRun(runId, outcome.status, outcome.detail, outcome.productId).catch((error) => {
      console.error(
        `[pipeline/post-once] failed to update cron_runs (id=${runId}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }
}
