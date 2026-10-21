import { NextResponse } from "next/server";
import { getPriceDropProducts } from "@/lib/price-drop-candidates";

const LIMIT = 10;

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await getPriceDropProducts(LIMIT);

  return NextResponse.json({
    // 値下げが検知された商品の総数（上位 LIMIT 件に絞る前）
    totalFound: rows[0]?.totalFound ?? 0,
    count: rows.length,
    products: rows.map((row) => ({
      id: row.id,
      name: row.name,
      currentPrice: row.currentPrice,
      previousPrice: row.previousPrice,
      dropAmount: row.dropAmount,
      dropRate: row.dropRate,
      reviewAverage: row.reviewAverage,
      reviewCount: row.reviewCount,
      // 投稿文に書く取得日時（直近2件の price_history）。JSON では ISO 文字列になる
      currentFetchedAt: row.currentFetchedAt,
      previousFetchedAt: row.previousFetchedAt,
      // 最安値の比較に使った記録（過去30日、今回を除く）の最安値と日数。今回の価格は lowestPrice より低い
      lowestPrice: row.lowestPrice,
      comparedDays: row.comparedDays,
      affiliateUrl: row.affiliateUrl,
      imageUrl: row.imageUrl,
      mainUnitReason: row.mainUnitReason,
    })),
  });
}
