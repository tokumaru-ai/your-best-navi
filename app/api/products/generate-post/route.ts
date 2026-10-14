import { NextResponse } from "next/server";
import { GET as getScoredProducts } from "../score/route";
import type { MainUnitReason } from "@/lib/main-unit";
import { buildPriceDropPost } from "@/lib/price-drop-post";

type ScoredProduct = {
  id: number;
  name: string;
  currentPrice: number;
  previousPrice: number;
  dropAmount: number;
  dropRate: number;
  reviewAverage: number | null;
  reviewCount: number | null;
  currentFetchedAt: string;
  previousFetchedAt: string;
  lowestPrice: number;
  comparedDays: number;
  affiliateUrl: string | null;
  imageUrl: string | null;
  mainUnitReason: MainUnitReason | null;
};

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 値下げ商品の上位は、score ルートのロジックをそのまま呼び出して取得する。
  // ?productId= が指定されればその商品を、なければ値下げ率トップ1件を使う
  // （post-once は重複防止を通った商品を選び、productId を指定して呼び出す）。
  const scoreRes = await getScoredProducts(request);
  if (!scoreRes.ok) {
    return NextResponse.json(
      { error: "値下げ商品の取得に失敗しました" },
      { status: 500 }
    );
  }
  const { products } = (await scoreRes.json()) as { products: ScoredProduct[] };
  const productIdParam = new URL(request.url).searchParams.get("productId");
  const product =
    productIdParam !== null
      ? products.find((p) => p.id === Number(productIdParam))
      : products[0];

  if (!product) {
    return NextResponse.json(
      {
        error:
          productIdParam !== null
            ? `productId=${productIdParam} は値下げ商品の上位に含まれていません`
            : "値下げが検知された商品がありません",
      },
      { status: 404 }
    );
  }
  if (!product.affiliateUrl) {
    return NextResponse.json(
      { error: "対象商品に affiliate_url がありません", product },
      { status: 422 }
    );
  }

  const post = buildPriceDropPost(product, product.affiliateUrl);
  if (!post) {
    return NextResponse.json(
      { error: "価格の取得日時、または比較した記録の日数が足りないため、投稿文を作れません", product },
      { status: 422 }
    );
  }

  return NextResponse.json({
    post,
    // ルールが守られているかの簡易チェック（ブロックはせず、確認用に返す）
    checks: {
      length: post.length,
      endsWithPR: post.endsWith("#PR"),
      containsAffiliateUrl: post.includes(product.affiliateUrl),
    },
    product,
  });
}
