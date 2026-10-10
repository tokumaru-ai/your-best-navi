import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";
import { getTrendingCandidates, type TrendingProduct } from "@/lib/trending-candidates";
import type { MainUnitReason } from "@/lib/main-unit";
import { GET as fetchRakutenPrices } from "../../rakuten/fetch/route";
import { GET as generatePost } from "../../products/generate-post/route";
import { GET as getScoredProducts } from "../../products/score/route";
import { POST as postToX } from "../../x-post/route";
import { GET as fetchTrendingPosts } from "../../x-trending/fetch/route";
import { GET as extractTrendingProducts } from "../../x-trending/extract/route";
import { GET as matchTrendingRakuten } from "../../x-trending/match-rakuten/route";
import { GET as generateTrendingPost } from "../../x-trending/generate-post/route";

// 実測42〜45秒に対する安全マージン。Hobbyプランの上限（300秒）内に収まる値。
export const maxDuration = 120;

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
  mainUnitReason: MainUnitReason | null;
};

type GeneratedPostResponse = {
  post: string;
  checks: { length: number; endsWithPR: boolean; containsAffiliateUrl: boolean };
  model: string;
  product: GeneratedProduct;
};

// x-trending/generate-post のレスポンス形。商品の型は候補一覧と共通のものを lib から使う。
type TrendingGeneratedPostResponse = {
  post: string;
  checks: { length: number; endsWithPR: boolean; containsAffiliateUrl: boolean };
  model: string;
  product: TrendingProduct;
};

type PostSource = "trending" | "price_drop";

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

// 同じ商品を再投稿しない期間
const DEDUP_DAYS = 14;

// 候補を上位から順に見て、DEDUP_DAYS 日以内に投稿していない最初の商品IDを返す。
// すべて投稿済み（または候補なし）なら undefined。
async function pickFirstNotRecentlyPosted(
  productIds: number[]
): Promise<number | undefined> {
  if (productIds.length === 0) return undefined;
  const rows = (await getSql().query(
    `
    SELECT product_id FROM post_dedup
    WHERE product_id = ANY($1::int[])
      AND last_posted_at > now() - make_interval(days => $2)
    `,
    [productIds, DEDUP_DAYS]
  )) as { product_id: number }[];
  const recentlyPosted = new Set(rows.map((row) => row.product_id));
  return productIds.find((id) => !recentlyPosted.has(id));
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

// Xトレンド経由で実際に投稿できた場合のみ、その商品にマッチした未使用の x_trending_posts すべてに印を付ける。
// 候補は商品単位で集約しているため、代表の1行だけに印を付けると、残りの行から同じ商品が再び候補に上がる。
async function markTrendingPosted(productId: number) {
  await getSql().query(
    `
    UPDATE x_trending_posts SET posted_from_trending = true
    WHERE rakuten_product_id = $1 AND posted_from_trending = false
    `,
    [productId]
  );
}

// X検索（x-trending/fetch）は従量課金のため、前回の取得からこの時間がたつまで実行しない（実質2日に1回）
const TRENDING_FETCH_INTERVAL_HOURS = 40;

// x_trending_posts の最新の fetched_at からの経過時間（時間）。1件もなければ null。
async function hoursSinceLastTrendingFetch(): Promise<number | null> {
  const rows = (await getSql().query(
    `
    SELECT EXTRACT(EPOCH FROM (now() - MAX(fetched_at))) / 3600 AS hours
    FROM x_trending_posts
    `
  )) as { hours: string | number | null }[];
  const hours = rows[0]?.hours;
  return hours === null || hours === undefined ? null : Number(hours);
}

// 下流の generate-post に、選んだ商品を ?productId= で指定するためのリクエストを作る
function withProductId(base: Request, productId: number): Request {
  const url = new URL(base.url);
  url.searchParams.set("productId", String(productId));
  return new Request(url, { headers: base.headers });
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
  // X検索を実行したかスキップしたかを、cron_runs の detail に併記する
  let trendingFetchNote: string | null = null;

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

    // 0.5 Xトレンド経路のデータを更新する（取得→商品名抽出→楽天マッチング）。
    // いずれかが失敗しても、後段の値下げ経路へのフォールバックがあるため続行する。
    // 取得（X検索）は前回から TRENDING_FETCH_INTERVAL_HOURS 時間以上たった場合のみ行う。
    // 抽出・マッチングは未処理分を処理するため毎回実行する。
    let runTrendingFetch = true;
    try {
      const hours = await hoursSinceLastTrendingFetch();
      if (hours === null) {
        trendingFetchNote = "x-search: 実行（取得履歴なし）";
      } else if (hours >= TRENDING_FETCH_INTERVAL_HOURS) {
        trendingFetchNote = `x-search: 実行（前回から${hours.toFixed(1)}時間）`;
      } else {
        runTrendingFetch = false;
        trendingFetchNote = `x-search: スキップ（前回から${hours.toFixed(1)}時間 < ${TRENDING_FETCH_INTERVAL_HOURS}時間）`;
      }
    } catch (error) {
      // 経過時間を確認できない場合は、従来どおり検索を実行する
      trendingFetchNote = "x-search: 実行（前回取得時刻の確認に失敗）";
      console.error(
        `[pipeline/post-once] last trending fetch check threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    console.log(`[pipeline/post-once] ${trendingFetchNote}`);

    const trendingRefreshSteps: {
      label: string;
      run: (req: Request) => Promise<Response>;
    }[] = [
      ...(runTrendingFetch ? [{ label: "x-trending/fetch", run: fetchTrendingPosts }] : []),
      { label: "x-trending/extract", run: extractTrendingProducts },
      { label: "x-trending/match-rakuten", run: matchTrendingRakuten },
    ];

    for (const step of trendingRefreshSteps) {
      try {
        const res = await step.run(internalRequest);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.error(`[pipeline/post-once] ${step.label} failed: ${JSON.stringify(body)}`);
        }
      } catch (error) {
        console.error(
          `[pipeline/post-once] ${step.label} threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // d. Xトレンド経由の投稿候補（商品単位で集約した反応数上位）を上から順に見て、
    // DEDUP_DAYS 日以内に投稿していない最初の商品を選ぶ。dry-run でも同じ選び方をする（読み取りのみ）。
    // 候補なし・全件投稿済み・生成失敗のいずれでも、値下げ経路にフォールバックする。
    let trendingPost: TrendingGeneratedPostResponse | null = null;
    try {
      const candidates = await getTrendingCandidates();
      const productId = await pickFirstNotRecentlyPosted(candidates.map((c) => c.id));
      if (productId !== undefined) {
        const trendingRes = await generateTrendingPost(withProductId(internalRequest, productId));
        if (trendingRes.ok) {
          trendingPost = (await trendingRes.json()) as TrendingGeneratedPostResponse;
        } else {
          const body = await trendingRes.json().catch(() => ({}));
          console.error(
            `[pipeline/post-once] x-trending/generate-post failed: ${JSON.stringify(body)}`
          );
        }
      } else if (candidates.length > 0) {
        console.log(
          `[pipeline/post-once] Xトレンド候補${candidates.length}件はすべて${DEDUP_DAYS}日以内に投稿済みのため、値下げ経路へフォールバック`
        );
      }
    } catch (error) {
      console.error(
        `[pipeline/post-once] x-trending candidate selection threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let source: PostSource;
    let post: string;
    let product: GeneratedProduct | TrendingProduct;
    let checks: { length: number; endsWithPR: boolean; containsAffiliateUrl: boolean };

    if (trendingPost) {
      // Xトレンドで条件を満たす商品があれば、そちらを優先する
      source = "trending";
      post = trendingPost.post;
      product = trendingPost.product;
      checks = trendingPost.checks;
    } else {
      source = "price_drop";

      // a. 値下げ率の上位を上から順に見て、DEDUP_DAYS 日以内に投稿していない最初の商品を選ぶ
      const scoreRes = await getScoredProducts(internalRequest);
      if (!scoreRes.ok) {
        outcome = { status: "failed", detail: "price_drop: 値下げ商品の取得に失敗しました" };
        return NextResponse.json(
          { error: "値下げ商品の取得に失敗しました", dryRun },
          { status: 500 }
        );
      }
      const { products: scored } = (await scoreRes.json()) as { products: GeneratedProduct[] };

      if (scored.length === 0) {
        outcome = { status: "skipped", detail: "price_drop: 値下げが検知された商品がありません" };
        return NextResponse.json(
          { error: "値下げが検知された商品がありません", dryRun },
          { status: 404 }
        );
      }

      const productId = await pickFirstNotRecentlyPosted(scored.map((p) => p.id));
      if (productId === undefined) {
        const reason = `値下げ商品の上位${scored.length}件すべてが${DEDUP_DAYS}日以内に投稿済み`;
        outcome = { status: "skipped", detail: `price_drop: ${reason}` };
        return NextResponse.json({ skipped: true, reason, source, dryRun });
      }

      const generateRes = await generatePost(withProductId(internalRequest, productId));

      if (!generateRes.ok) {
        const errorBody = (await generateRes.json().catch(() => ({}))) as { error?: string };
        const errorMessage = errorBody.error ?? "投稿文の生成に失敗しました";

        if (!dryRun) {
          await recordPost({
            productId,
            postText: "",
            status: "failed",
            errorMessage,
          });
        }

        outcome = { status: "failed", detail: `price_drop: ${errorMessage}`, productId };
        return NextResponse.json({ error: errorMessage, dryRun }, { status: 500 });
      }

      const generated = (await generateRes.json()) as GeneratedPostResponse;
      post = generated.post;
      product = generated.product;
      checks = generated.checks;
    }

    if (dryRun) {
      // 実際のXアクセス（uploadMedia・tweet）は一切行わず、画像取得までを検証する
      const image = product.imageUrl ? await checkImage(product.imageUrl) : null;

      outcome = {
        status: "success",
        detail: `${source}: dry-run: 実際の投稿は行っていません`,
        productId: product.id,
      };
      return NextResponse.json({
        dryRun: true,
        wouldPost: true,
        trendingFetch: trendingFetchNote,
        source,
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
      outcome = { status: "failed", detail: `${source}: ${errorMessage}`, productId: product.id };
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }

    await recordPost({
      productId: product.id,
      postText: post,
      status: "success",
    });

    // e. 投稿成功時のみ dedup を更新する
    await upsertDedup(product.id);

    // Xトレンド経由で実際に投稿できた場合のみ、該当する x_trending_posts に印を付ける
    if (source === "trending") {
      await markTrendingPosted(product.id);
    }

    outcome = { status: "success", detail: source, productId: product.id };
    return NextResponse.json({
      posted: true,
      source,
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
    const detail = [outcome.detail, trendingFetchNote].filter(Boolean).join(" / ") || null;
    await finishRun(runId, outcome.status, detail, outcome.productId).catch((error) => {
      console.error(
        `[pipeline/post-once] failed to update cron_runs (id=${runId}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }
}
