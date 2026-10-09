import { NextResponse } from "next/server";
import { ensureSchema, getSql } from "@/lib/db";

// genre_id 列の追加前に保存された商品について、楽天の商品検索APIを商品コードで引き直し、
// genre_id を埋めるための一回限りの処理。全件埋まったら不要になる。
//
// 楽天APIは1アプリあたり1リクエスト/秒の制限があるため、リクエスト間で待つ（rakuten/fetchと同じ間隔）
const INTERVAL_MS = 1100;
// 1回の実行で処理する件数の上限（関数のタイムアウト対策）。?limit= で小さくできる
const MAX_BATCH_SIZE = 100;
// 100件 × (待ち1.1秒 + API応答) に対する余裕を持たせた値。Hobbyプランの上限（300秒）内。
export const maxDuration = 300;

// 本体候補（iPhone・Apple Watch・AirPods）を先に処理する
const PRIORITY_NAME_PATTERN = "(iphone|apple ?watch|アップルウォッチ|airpods)";

type TargetRow = { id: number; external_id: string; name: string };

type BackfillResult = {
  productId: number;
  genreId?: number;
  notFound?: boolean;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookupGenreId(itemCode: string): Promise<number | null> {
  const appId = process.env.RAKUTEN_APP_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  const origin = process.env.RAKUTEN_ORIGIN ?? "";

  const url =
    `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701` +
    `?applicationId=${appId}` +
    `&accessKey=${accessKey}` +
    `&itemCode=${encodeURIComponent(itemCode)}`;

  const res = await fetch(url, { headers: { Origin: origin } });
  const data = await res.json();

  if (!res.ok || data.errors || !Array.isArray(data.Items)) {
    // URL にキーが含まれるので、エラー本文だけを使う
    const detail = data.errors
      ? `${data.errors.errorCode} ${data.errors.errorMessage}`
      : data.error_description ?? "unexpected response";
    throw new Error(`Rakuten API error (HTTP ${res.status}): ${detail}`);
  }

  const genreId = data.Items[0]?.Item?.genreId;
  return genreId !== undefined && genreId !== "" ? Number(genreId) : null;
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

  const limitParam = Number(new URL(request.url).searchParams.get("limit"));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_BATCH_SIZE)
      : MAX_BATCH_SIZE;

  await ensureSchema();

  // 楽天で見つからなかった商品（販売終了など）は genre_id が NULL のまま残り、次回も対象になる。
  // その分だけ1回で埋められる件数が減るが、remaining が notFound の件数まで減れば完了とみなせる。
  const targets = (await getSql().query(
    `
    SELECT id, external_id, name
    FROM products
    WHERE source = 'rakuten' AND genre_id IS NULL
    ORDER BY (name ~* $1) DESC, id ASC
    LIMIT $2
    `,
    [PRIORITY_NAME_PATTERN, limit]
  )) as TargetRow[];

  const results: BackfillResult[] = [];

  for (const [index, row] of targets.entries()) {
    if (index > 0) await sleep(INTERVAL_MS);

    try {
      const genreId = await lookupGenreId(row.external_id);
      if (genreId === null) {
        results.push({ productId: row.id, notFound: true });
        continue;
      }
      await getSql().query(`UPDATE products SET genre_id = $2 WHERE id = $1`, [
        row.id,
        genreId,
      ]);
      results.push({ productId: row.id, genreId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[rakuten/backfill-genre] product ${row.id} failed: ${message}`);
      results.push({ productId: row.id, error: message });
    }
  }

  const [{ remaining }] = (await getSql().query(
    `SELECT count(*)::int AS remaining FROM products WHERE source = 'rakuten' AND genre_id IS NULL`
  )) as { remaining: number }[];

  return NextResponse.json({
    processed: targets.length,
    updated: results.filter((r) => r.genreId !== undefined).length,
    notFound: results.filter((r) => r.notFound).length,
    errors: results.filter((r) => r.error).length,
    remaining,
    results,
  });
}
