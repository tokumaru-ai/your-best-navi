import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { upsizeImage } from "@/lib/rakuten-image";

// genreId は調査時点（GenreSearch API で実際に特定した値）のもの。
// 楽天側でジャンル構成が変わることがあるため、値が合わなくなったら再調査する。
const GENRES = [
  { genreId: 560276, category: "スマートフォン・タブレットアクセサリ" },
  { genreId: 502835, category: "イヤホン・ヘッドホン" },
  { genreId: 568380, category: "スマートウォッチ・アクセサリ" },
  { genreId: 509433, category: "モバイルバッテリー・充電器" },
];
const HITS = 10;

// 店単位の取得。楽天モバイル公式 楽天市場店の Apple 製品を、shopCode を指定してキーワード検索する
const SHOP = {
  shopCode: "rakutenmobile-store",
  category: "楽天モバイル",
  keywords: ["iPhone", "AirPods", "Apple Watch"],
  pages: 2,
};
const SHOP_SEARCH_HITS = 30;
const SHOP_ITEM_NAME_PATTERN = /iPhone|iPad|AirPods|Apple Watch|Apple/i;
const SHOP_ITEM_EXCLUDE_PATTERN = /中古|訳あり/;
// 楽天APIは1アプリあたり1リクエスト/秒の制限があるため、ジャンル間で待つ
const INTERVAL_MS = 1100;

type RakutenItem = {
  itemCode: string;
  itemName: string;
  itemPrice: number;
  itemUrl?: string;
  shopCode?: string;
  affiliateUrl?: string;
  mediumImageUrls?: { imageUrl: string }[];
  reviewCount?: number;
  reviewAverage?: number;
  rank?: number;
  // 1: 在庫あり、0: 在庫なし
  availability?: number;
  // ランキングAPIは genreId を文字列で返す（商品検索APIは数値）
  genreId?: number | string;
};

type KeywordResult = {
  keyword: string;
  found: number;
  error?: string;
};

type GenreResult = {
  category: string;
  genreId: number;
  saved: number;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRanking(genreId: number): Promise<RakutenItem[]> {
  const appId = process.env.RAKUTEN_APP_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  const affiliateId = process.env.RAKUTEN_AFFILIATE_ID;
  const origin = process.env.RAKUTEN_ORIGIN ?? "";

  const url =
    `https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601` +
    `?applicationId=${appId}` +
    `&accessKey=${accessKey}` +
    `&affiliateId=${affiliateId}` +
    `&genreId=${genreId}` +
    `&page=1`;

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

  return data.Items.map((entry: { Item: RakutenItem }) => entry.Item).slice(0, HITS);
}

async function searchItems(keyword: string, page: number): Promise<RakutenItem[]> {
  const appId = process.env.RAKUTEN_APP_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  const affiliateId = process.env.RAKUTEN_AFFILIATE_ID;
  const origin = process.env.RAKUTEN_ORIGIN ?? "";

  const url =
    `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701` +
    `?applicationId=${appId}` +
    `&accessKey=${accessKey}` +
    `&affiliateId=${affiliateId}` +
    `&shopCode=${SHOP.shopCode}` +
    `&keyword=${encodeURIComponent(keyword)}` +
    `&hits=${SHOP_SEARCH_HITS}` +
    `&page=${page}` +
    // 既定では在庫のある商品しか返らない。在庫切れになった商品も取得し、availability = 0 を記録して投稿候補から外すため、すべて返させる
    `&availability=0`;

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

function isShopTarget(item: RakutenItem): boolean {
  return (
    item.shopCode === SHOP.shopCode &&
    SHOP_ITEM_NAME_PATTERN.test(item.itemName) &&
    !SHOP_ITEM_EXCLUDE_PATTERN.test(item.itemName)
  );
}

// keepCategory が true のときは、すでにある商品の category を変えない（新規の商品にだけ category を付ける）
async function saveItems(
  category: string,
  items: RakutenItem[],
  { keepCategory = false }: { keepCategory?: boolean } = {}
): Promise<number> {
  const client = await getPool().connect();

  // ジャンル単位で1トランザクション。途中で失敗したらそのジャンル分は保存しない
  try {
    await client.query("BEGIN");

    for (const [index, item] of items.entries()) {
      const { rows } = await client.query(
        `
        INSERT INTO products
          (source, external_id, name, image_url, item_url, affiliate_url, category, genre_id)
        VALUES
          ('rakuten', $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (source, external_id) DO UPDATE SET
          name          = excluded.name,
          image_url     = excluded.image_url,
          item_url      = excluded.item_url,
          affiliate_url = excluded.affiliate_url,
          category      = CASE WHEN $8 THEN products.category ELSE excluded.category END,
          genre_id      = COALESCE(excluded.genre_id, products.genre_id),
          updated_at    = now()
        RETURNING id
        `,
        [
          item.itemCode,
          item.itemName,
          item.mediumImageUrls?.[0]?.imageUrl
            ? upsizeImage(item.mediumImageUrls[0].imageUrl)
            : null,
          item.itemUrl ?? null,
          item.affiliateUrl ?? null,
          category,
          item.genreId !== undefined && item.genreId !== "" ? Number(item.genreId) : null,
          keepCategory,
        ]
      );
      const productId = rows[0].id as number;

      await client.query(
        `
        INSERT INTO price_history
          (product_id, price, review_count, review_average, rank, availability)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          productId,
          item.itemPrice,
          item.reviewCount ?? null,
          item.reviewAverage ?? null,
          // ランキング上の順位（1始まり）。取れない場合は取得順で代用する
          item.rank ?? index + 1,
          item.availability ?? null,
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

  const results: GenreResult[] = [];

  for (const [index, genre] of GENRES.entries()) {
    if (index > 0) await sleep(INTERVAL_MS);

    try {
      const items = await fetchRanking(genre.genreId);
      const saved = await saveItems(genre.category, items);
      results.push({ category: genre.category, genreId: genre.genreId, saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[rakuten/fetch] genreId=${genre.genreId} (${genre.category}) failed: ${message}`);
      results.push({ category: genre.category, genreId: genre.genreId, saved: 0, error: message });
    }
  }

  // 店単位の取得。キーワード間で同じ商品が重複するため itemCode でまとめてから1回で保存する
  const shopItems = new Map<string, RakutenItem>();
  const keywordResults: KeywordResult[] = [];

  for (const keyword of SHOP.keywords) {
    let found = 0;
    try {
      for (let page = 1; page <= SHOP.pages; page++) {
        await sleep(INTERVAL_MS);
        const items = await searchItems(keyword, page);
        for (const item of items.filter(isShopTarget)) {
          shopItems.set(item.itemCode, item);
          found++;
        }
        if (items.length < SHOP_SEARCH_HITS) break;
      }
      keywordResults.push({ keyword, found });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[rakuten/fetch] shop=${SHOP.shopCode} keyword="${keyword}" failed: ${message}`);
      keywordResults.push({ keyword, found, error: message });
    }
  }

  let shopSaved = 0;
  let shopError: string | undefined;
  try {
    shopSaved = await saveItems(SHOP.category, [...shopItems.values()], {
      keepCategory: true,
    });
  } catch (error) {
    shopError = error instanceof Error ? error.message : String(error);
    console.error(`[rakuten/fetch] shop=${SHOP.shopCode} save failed: ${shopError}`);
  }

  return NextResponse.json({
    saved: results.reduce((sum, r) => sum + r.saved, 0) + shopSaved,
    errors:
      results.filter((r) => r.error).length +
      keywordResults.filter((r) => r.error).length +
      (shopError ? 1 : 0),
    results,
    shop: {
      shopCode: SHOP.shopCode,
      category: SHOP.category,
      saved: shopSaved,
      ...(shopError ? { error: shopError } : {}),
      keywords: keywordResults,
    },
  });
}
