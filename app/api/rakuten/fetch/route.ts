import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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

function saveItems(keyword: string, items: RakutenItem[]): number {
  const db = getDb();

  const upsertProduct = db.prepare(`
    INSERT INTO products
      (source, external_id, name, image_url, item_url, affiliate_url, category)
    VALUES
      ('rakuten', @externalId, @name, @imageUrl, @itemUrl, @affiliateUrl, @category)
    ON CONFLICT (source, external_id) DO UPDATE SET
      name          = excluded.name,
      image_url     = excluded.image_url,
      item_url      = excluded.item_url,
      affiliate_url = excluded.affiliate_url,
      category      = excluded.category,
      updated_at    = datetime('now')
    RETURNING id
  `);

  const insertHistory = db.prepare(`
    INSERT INTO price_history
      (product_id, price, review_count, review_average, rank)
    VALUES
      (@productId, @price, @reviewCount, @reviewAverage, @rank)
  `);

  // キーワード単位で1トランザクション。途中で失敗したらそのキーワード分は保存しない
  const saveAll = db.transaction((rows: RakutenItem[]) => {
    rows.forEach((item, index) => {
      const { id } = upsertProduct.get({
        externalId: item.itemCode,
        name: item.itemName,
        imageUrl: item.mediumImageUrls?.[0]?.imageUrl ?? null,
        itemUrl: item.itemUrl ?? null,
        affiliateUrl: item.affiliateUrl ?? null,
        category: keyword,
      }) as { id: number };

      insertHistory.run({
        productId: id,
        price: item.itemPrice,
        reviewCount: item.reviewCount ?? null,
        reviewAverage: item.reviewAverage ?? null,
        // 検索結果内の表示順（1始まり）
        rank: index + 1,
      });
    });

    return rows.length;
  });

  return saveAll(items);
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

  const results: KeywordResult[] = [];

  for (const [index, keyword] of KEYWORDS.entries()) {
    if (index > 0) await sleep(INTERVAL_MS);

    try {
      const items = await searchRakuten(keyword);
      const saved = saveItems(keyword, items);
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
