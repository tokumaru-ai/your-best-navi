import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";
import { upsizeImage } from "@/lib/rakuten-image";

const HITS = 1;
// 楽天APIは1アプリあたり1リクエスト/秒の制限があるため、検索間で待つ（rakuten/fetchと同じ間隔）
const INTERVAL_MS = 1100;
// 1回の実行で処理する件数の上限（関数のタイムアウト対策）
const BATCH_SIZE = 20;
// この文字列を含む商品名は、返礼品であって「話題の商品」そのものではないため除外する
const FURUSATO_KEYWORD = "ふるさと納税";

// Apple製品・周辺機器に絞り込むための対象ジャンル（これ自身、またはこの配下のみ採用する）。
// 楽天の検索結果は末端の子ジャンルIDを返すため、祖先をたどって判定する必要がある。
// 例: iPhoneケースは 560271（ケース・カバー）で返り、その祖先に 560276 が含まれる。
// Apple Watchのバンドは 568380 ではなく 302178（腕時計用アクセサリー）配下に分類されている。
const ALLOWED_GENRE_IDS = new Set([
  560276, // スマートフォン・携帯電話アクセサリー（iPhoneケース・保護フィルムなど）
  502835, // ヘッドホン・イヤホン（AirPodsなど）
  568380, // スマートウォッチアクセサリー
  302178, // 腕時計用アクセサリー（Apple Watchのバンド・ベルトなど）
]);

// 本体・充電器系ジャンル。Android端末や他社製充電器も含まれるため、ジャンルだけでは判定せず、
// 商品名にAppleブランドのキーワードを含む場合のみ許可する（下のcontainsAppleBrandで判定）。
const BRAND_RESTRICTED_GENRE_IDS = new Set([
  560202, // スマートフォン本体
  564895, // スマートウォッチ本体
  509433, // モバイルバッテリー・充電器
  509434, // AC式充電器
]);

const APPLE_BRAND_KEYWORDS = [
  "Apple",
  "iPhone",
  "iPad",
  "AirPods",
  "Apple Watch",
  "MagSafe",
];

function containsAppleBrand(itemName: string): boolean {
  const lower = itemName.toLowerCase();
  return APPLE_BRAND_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

type RakutenItem = {
  itemCode: string;
  itemName: string;
  itemPrice: number;
  itemUrl?: string;
  affiliateUrl?: string;
  mediumImageUrls?: { imageUrl: string }[];
  reviewCount?: number;
  reviewAverage?: number;
  genreId?: number;
};

// 楽天APIがエラーを返した際、HTTPステータスを呼び出し側で参照できるようにする。
// 429・5xxは一時的な失敗として扱い再試行、それ以外（400等）は恒久的な失敗として扱う。
class RakutenApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type GenreClassification = "accessory" | "brand-restricted" | "disallowed";

// genreId の分類結果。GenreSearch APIの呼び出し回数を抑えるため、
// プロセス内でキャッシュする（同じジャンルは2回目以降APIを呼ばない）。
const genreClassifyCache = new Map<number, GenreClassification>();

function rakutenCredentials() {
  return {
    appId: process.env.RAKUTEN_APP_ID,
    accessKey: process.env.RAKUTEN_ACCESS_KEY,
    affiliateId: process.env.RAKUTEN_AFFILIATE_ID,
    origin: process.env.RAKUTEN_ORIGIN ?? "",
  };
}

// 祖先をたどって、ジャンルを分類する。
// 判定できなかった場合（APIエラー）は例外を投げ、呼び出し側で「未チェックのまま次回再試行」にする。
async function classifyGenre(genreId: number): Promise<GenreClassification> {
  if (ALLOWED_GENRE_IDS.has(genreId)) return "accessory";
  if (BRAND_RESTRICTED_GENRE_IDS.has(genreId)) return "brand-restricted";

  const cached = genreClassifyCache.get(genreId);
  if (cached !== undefined) return cached;

  const { appId, accessKey, origin } = rakutenCredentials();
  const url =
    `https://openapi.rakuten.co.jp/ichibagt/api/IchibaGenre/Search/20260701` +
    `?applicationId=${appId}` +
    `&accessKey=${accessKey}` +
    `&genreId=${genreId}`;

  const res = await fetch(url, { headers: { Origin: origin } });
  const data = await res.json();

  if (!res.ok || data.errors || !data.genre) {
    const detail = data.errors
      ? `${data.errors.errorCode} ${data.errors.errorMessage}`
      : "unexpected response";
    throw new RakutenApiError(
      res.status,
      `Rakuten GenreSearch error (HTTP ${res.status}): ${detail}`
    );
  }

  const ancestors = (data.ancestors ?? []) as { genreId: number }[];
  let classification: GenreClassification = "disallowed";
  if (ancestors.some((a) => ALLOWED_GENRE_IDS.has(a.genreId))) {
    classification = "accessory";
  } else if (ancestors.some((a) => BRAND_RESTRICTED_GENRE_IDS.has(a.genreId))) {
    classification = "brand-restricted";
  }

  genreClassifyCache.set(genreId, classification);
  return classification;
}

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

// 商品の genreId を分類する。genreId が返っていない場合は、
// 絞り込みの目的上、安全側に倒して「対象外」とする。
// キャッシュに無くAPIを呼ぶ場合のみ、楽天のレート制限（1秒1リクエスト）を考慮して待つ。
async function checkGenre(genreId: number | undefined): Promise<GenreClassification> {
  if (genreId === undefined) return "disallowed";
  if (
    ALLOWED_GENRE_IDS.has(genreId) ||
    BRAND_RESTRICTED_GENRE_IDS.has(genreId) ||
    genreClassifyCache.has(genreId)
  ) {
    return classifyGenre(genreId);
  }
  await sleep(INTERVAL_MS);
  return classifyGenre(genreId);
}

// 商品名から1文字だけの単語（世代番号の「2」「3」、記号の「-」「×」など）を取り除く。
// これらは楽天の検索キーワードとして単独で含まれると400エラーになることがあるため。
function stripSingleCharTokens(keyword: string): string {
  const cleaned = keyword
    .split(/\s+/)
    .filter((token) => [...token].length > 1)
    .join(" ");
  // 全トークンが1文字判定になるような異常なケースでは、元のキーワードのまま使う
  return cleaned.length > 0 ? cleaned : keyword;
}

async function searchRakuten(keyword: string): Promise<RakutenItem[]> {
  const { appId, accessKey, affiliateId, origin } = rakutenCredentials();

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
    throw new RakutenApiError(
      res.status,
      `Rakuten API error (HTTP ${res.status}): ${detail}`
    );
  }

  return data.Items.map((entry: { Item: RakutenItem }) => entry.Item);
}

async function upsertProduct(item: RakutenItem): Promise<number> {
  const rows = (await getSql().query(
    `
    INSERT INTO products
      (source, external_id, name, image_url, item_url, affiliate_url, category, genre_id)
    VALUES
      ('rakuten', $1, $2, $3, $4, $5, 'Xトレンド', $6)
    ON CONFLICT (source, external_id) DO UPDATE SET
      name          = excluded.name,
      image_url     = excluded.image_url,
      item_url      = excluded.item_url,
      affiliate_url = excluded.affiliate_url,
      category      = excluded.category,
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
      item.genreId ?? null,
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
      const cleanedKeyword = stripSingleCharTokens(row.extracted_product_name);
      const items = await searchRakuten(cleanedKeyword);
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
        const classification = await checkGenre(item.genreId);
        const brandOk =
          classification === "accessory" ||
          (classification === "brand-restricted" && containsAppleBrand(item.itemName));

        if (!brandOk) {
          // 対象ジャンル外、または本体・充電器ジャンルだがApple関連の商品名を含まない商品は登録しない。
          // 検索自体は成功しているので、rakuten_checked_at は更新して再検索の対象から外す。
          await getSql().query(
            `UPDATE x_trending_posts SET rakuten_checked_at = now() WHERE id = $1`,
            [row.id]
          );
          const reason =
            classification === "disallowed"
              ? `対象ジャンル外のため除外（genreId=${item.genreId ?? "不明"}）`
              : `本体・充電器ジャンルだがApple関連の商品名を含まないため除外（genreId=${item.genreId}）`;
          results.push({
            trendingPostId: row.id,
            productName: row.extracted_product_name,
            matched: false,
            excluded: true,
            excludedReason: reason,
            itemName: item.itemName,
          });
        } else {
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
        }
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

      // 429（レート制限）・5xx（楽天側の一時的な不調）は次回再試行させるため rakuten_checked_at を更新しない。
      // それ以外の明確なクライアントエラー（400等）は、再試行しても直らないため恒久的な失敗として扱い、
      // rakuten_checked_at を更新して無限リトライを防ぐ。
      const status = error instanceof RakutenApiError ? error.status : undefined;
      const isPermanentClientError =
        status !== undefined && status !== 429 && status < 500;
      if (isPermanentClientError) {
        await getSql().query(
          `UPDATE x_trending_posts SET rakuten_checked_at = now() WHERE id = $1`,
          [row.id]
        );
      }

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
