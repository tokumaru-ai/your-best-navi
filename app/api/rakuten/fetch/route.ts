import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

const KEYWORDS = ["モバイルバッテリー", "タンブラー", "ランニングシューズ"];
const HITS = 5;
// 楽天APIは1アプリあたり1リクエスト/秒の制限があるため、キーワード間で待つ
const INTERVAL_MS = 1100;

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

type KeywordResult = {
  keyword: string;
  saved: number;
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

async function saveItems(keyword: string, items: RakutenItem[]): Promise<number> {
  const client = await getPool().connect();

  // キーワード単位で1トランザクション。途中で失敗したらそのキーワード分は保存しない
  try {
    await client.query("BEGIN");

    for (const [index, item] of items.entries()) {
      const { rows } = await client.query(
        `
        INSERT INTO products
          (source, external_id, name, image_url, item_url, affiliate_url, category)
        VALUES
          ('rakuten', $1, $2, $3, $4, $5, $6)
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
          keyword,
        ]
      );
      const productId = rows[0].id as number;

      await client.query(
        `
        INSERT INTO price_history
          (product_id, price, review_count, review_average, rank)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [
          productId,
          item.itemPrice,
          item.reviewCount ?? null,
          item.reviewAverage ?? null,
          // 検索結果内の表示順（1始まり）
          index + 1,
        ]
      );
    }

    await client.query("COMMIT");
    return items.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

  const results: KeywordResult[] = [];

  for (const [index, keyword] of KEYWORDS.entries()) {
    if (index > 0) await sleep(INTERVAL_MS);

    try {
      const items = await searchRakuten(keyword);
      const saved = await saveItems(keyword, items);
      results.push({ keyword, saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[rakuten/fetch] "${keyword}" failed: ${message}`);
      results.push({ keyword, saved: 0, error: message });
    }
  }

  return NextResponse.json({
    saved: results.reduce((sum, r) => sum + r.saved, 0),
    errors: results.filter((r) => r.error).length,
    results,
  });
}
