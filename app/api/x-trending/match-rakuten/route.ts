import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";

const HITS = 1;
// 楽天APIは1アプリあたり1リクエスト/秒の制限があるため、検索間で待つ（rakuten/fetchと同じ間隔）
const INTERVAL_MS = 1100;
// 1回の実行で処理する件数の上限（関数のタイムアウト対策）
const BATCH_SIZE = 20;
// この文字列を含む商品名は、返礼品であって「話題の商品」そのものではないため除外する
const FURUSATO_KEYWORD = "ふるさと納税";

type RakutenItem = {
  itemCode: string;
  itemName: string;
  itemPrice: number;
  itemUrl?: string;
  affiliateUrl?: string;
  mediumImageUrls?: { imageUrl: string }[];
  reviewCount?: number;
  reviewAverage?: number;
};

type PendingRow = {
  id: number;
  extracted_product_name: string;
};

type MatchResult = {
  trendingPostId: number;
  productName: string;
  matched: boolean;
  excluded?: boolean;
  excludedReason?: string;
  rakutenProductId?: number;
  itemName?: string;
  price?: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchRakuten(keyword: string): Promise<RakutenItem[]> {
  const appId = process.env.RAKUTEN_APP_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  const affiliateId = process.env.RAKUTEN_AFFILIATE_ID;
  const origin = process.env.RAKUTEN_ORIGIN ?? "";

  const url =
    `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701` +
    `?applicationId=${appId}` +
    `&accessKey=${accessKey}` +
    `&affiliateId=${affiliateId}` +
    `&keyword=${encodeURIComponent(keyword)}` +
    `&hits=${HITS}`;

  const res = await fetch(url, {
    headers: {
      Origin: origin,
    },
  });
  const data = await res.json();

  if (!res.ok || data.errors || !Array.isArray(data.Items)) {
    // URL にキーが含まれるので、エラー本文だけを使う
    const detail = data.errors
      ? `${data.errors.errorCode} ${data.errors.errorMessage}`
      : data.error_description ?? "unexpected response";
    throw new Error(`Rakuten API error (HTTP ${res.status}): ${detail}`);
  }

  return data.Items.map((entry: { Item: RakutenItem }) => entry.Item);
}

async function upsertProduct(item: RakutenItem): Promise<number> {
  const rows = (await getSql().query(
    `
    INSERT INTO products
      (source, external_id, name, image_url, item_url, affiliate_url, category)
    VALUES
      ('rakuten', $1, $2, $3, $4, $5, 'Xトレンド')
    ON CONFLICT (source, external_id) DO UPDATE SET
      name          = excluded.name,
      image_url     = excluded.image_url,
      item_url      = excluded.item_url,
      affiliate_url = excluded.affiliate_url,
      category      = excluded.category,
      updated_at    = now()
    RETURNING id
    `,
    [
      item.itemCode,
      item.itemName,
      item.mediumImageUrls?.[0]?.imageUrl ?? null,
      item.itemUrl ?? null,
      item.affiliateUrl ?? null,
    ]
  )) as { id: number }[];

  return rows[0].id;
}

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.RAKUTEN_APP_ID) {
    return NextResponse.json(
      { error: "RAKUTEN_APP_ID が設定されていません" },
      { status: 500 }
    );
  }

  await ensureSchema();

  const pending = (await getSql().query(
    `
    SELECT id, extracted_product_name
    FROM x_trending_posts
    WHERE extracted_product_name IS NOT NULL
      AND rakuten_checked_at IS NULL
    ORDER BY reaction_score DESC NULLS LAST, fetched_at ASC
    LIMIT $1
    `,
    [BATCH_SIZE]
  )) as PendingRow[];

  const results: MatchResult[] = [];

  for (const [index, row] of pending.entries()) {
    if (index > 0) await sleep(INTERVAL_MS);

    try {
      const items = await searchRakuten(row.extracted_product_name);
      const item = items[0];

      if (item && item.itemName.includes(FURUSATO_KEYWORD)) {
        // ふるさと納税の返礼品は「話題の商品」そのものではないため、products への登録をスキップする。
        // ただし検索自体は成功しているので、rakuten_checked_at は更新して再検索の対象から外す。
        await getSql().query(
          `UPDATE x_trending_posts SET rakuten_checked_at = now() WHERE id = $1`,
          [row.id]
        );
        results.push({
          trendingPostId: row.id,
          productName: row.extracted_product_name,
          matched: false,
          excluded: true,
          excludedReason: `商品名に「${FURUSATO_KEYWORD}」を含むため除外`,
          itemName: item.itemName,
        });
      } else if (item) {
        const productId = await upsertProduct(item);
        await getSql().query(
          `
          UPDATE x_trending_posts
          SET rakuten_product_id = $2, rakuten_checked_at = now(),
              current_price = $3, review_average = $4, review_count = $5
          WHERE id = $1
          `,
          [
            row.id,
            productId,
            item.itemPrice,
            item.reviewAverage ?? null,
            item.reviewCount ?? null,
          ]
        );
        results.push({
          trendingPostId: row.id,
          productName: row.extracted_product_name,
          matched: true,
          rakutenProductId: productId,
          itemName: item.itemName,
          price: item.itemPrice,
        });
      } else {
        // ヒットしなかった場合も rakuten_checked_at だけ更新し、再検索の対象から外す
        await getSql().query(
          `UPDATE x_trending_posts SET rakuten_checked_at = now() WHERE id = $1`,
          [row.id]
        );
        results.push({
          trendingPostId: row.id,
          productName: row.extracted_product_name,
          matched: false,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[x-trending/match-rakuten] "${row.extracted_product_name}" failed: ${message}`
      );
      // 検索自体が失敗した場合は rakuten_checked_at を更新しない（次回また未処理として拾われる）
      results.push({
        trendingPostId: row.id,
        productName: row.extracted_product_name,
        matched: false,
        error: message,
      });
    }
  }

  return NextResponse.json({
    pending: pending.length,
    matched: results.filter((r) => r.matched).length,
    excluded: results.filter((r) => r.excluded).length,
    errors: results.filter((r) => r.error).length,
    results,
  });
}
