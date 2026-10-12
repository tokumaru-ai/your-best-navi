import { NextResponse } from "next/server";
import { GET as getScoredProducts } from "../score/route";
import type { MainUnitReason } from "@/lib/main-unit";

type ScoredProduct = {
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

// 投稿文は生成AIを使わず、取得した実データ（価格・前回価格・レビュー）だけからテンプレートで組み立てる。
// 「Xで話題」「人気」など、取得していない根拠が文中に入らないようにするため。

// 投稿に載せる商品名の上限文字数。楽天の商品名は検索用キーワードが長く続くため、先頭だけを使う。
// 状態を示す括弧（【国内正規品/新品】など）を残すため、本体名が切れないよう長めにしている。
const NAME_MAX_LENGTH = 60;
// 空白で切るとき、これより短くなる場合は空白を待たずに文字数で切る
const NAME_MIN_CUT_LENGTH = 15;

// 括弧で囲まれた部分のうち、販売条件（送料・ポイント・発送日・クーポンなど）や、
// こちらで確かめていない宣伝文句（楽天1位・ランキングなど）を書いたものを取り除く。
// 状態を示す語（新品・未開封・正規品など）を含む括弧や、どちらか判断できない括弧は残す。
const BRACKETED_SEGMENT = /【[^】]*】|［[^］]*］|\[[^\]]*\]|《[^》]*》|≪[^≫]*≫|＜[^＞]*＞/g;
// 「マルチポイント接続」などの仕様をポイント還元と取り違えないよう、ポイントだけは直前の語を見る
const SALES_CONDITION_PATTERNS = [
  /楽天[1１]位|ランキング/,
  /お買い物マラソン|マラソン|お買い物/,
  /(?<!マルチ)ポイント|倍/,
  /最短|翌日|即日|発送|出荷|土日|祝日/,
  /送料無料|送料込/,
  /受取|受け取り|転送不可|本人確認|キャンセル|同梱/,
  /再入荷|在庫/,
  /クーポン|OFF|割引|半額|円/i,
  /期間|限定|まで/,
  /セール|SALE/,
];
const ITEM_STATE_KEYWORDS = ["新品", "未開封", "正規", "国内", "開封", "中古", "ランク", "海外版", "整備", "純正", "保証"];

function isSalesConditionOnly(segment: string): boolean {
  return (
    SALES_CONDITION_PATTERNS.some((pattern) => pattern.test(segment)) &&
    !ITEM_STATE_KEYWORDS.some((keyword) => segment.includes(keyword))
  );
}

function shortenName(name: string): string {
  const cleaned = name
    .replace(BRACKETED_SEGMENT, (segment) => (isSalesConditionOnly(segment) ? " " : segment))
    .replace(/[★☆◆◇■□●○♪]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || name.trim();
  if (base.length <= NAME_MAX_LENGTH) return base;

  const cut = base.slice(0, NAME_MAX_LENGTH + 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace >= NAME_MIN_CUT_LENGTH ? cut.slice(0, lastSpace) : base.slice(0, NAME_MAX_LENGTH);
  return `${head}…`;
}

function formatYen(value: number): string {
  return `¥${value.toLocaleString("ja-JP")}`;
}

// 値下げ率は前回価格と現在価格から計算する（score の dropRate は NUMERIC で文字列になるため使わない）。
// 1%未満は「0%OFF」にならないよう小数1桁で表示する。
function formatDropRate(previousPrice: number, currentPrice: number): string {
  const rate = ((previousPrice - currentPrice) / previousPrice) * 100;
  const rounded = Math.round(rate);
  return rounded >= 1 ? `${rounded}%` : `${rate.toFixed(1)}%`;
}

// レビューは取得できた値だけを書く。件数0件のときの評価（0）は実データではないため書かない。
function formatReview(reviewAverage: number | null, reviewCount: number | null): string | null {
  const hasCount = reviewCount !== null && reviewCount > 0;
  const hasAverage = reviewAverage !== null && reviewAverage > 0 && reviewCount !== 0;
  if (hasAverage && hasCount) {
    return `レビュー評価${reviewAverage}（${reviewCount.toLocaleString("ja-JP")}件）`;
  }
  if (hasAverage) return `レビュー評価${reviewAverage}`;
  if (hasCount) return `レビュー${reviewCount.toLocaleString("ja-JP")}件`;
  return null;
}

function buildPost(product: ScoredProduct, affiliateUrl: string): string {
  const priceLine = `${formatYen(product.previousPrice)} → ${formatYen(product.currentPrice)}（${formatDropRate(
    product.previousPrice,
    product.currentPrice
  )}OFF）`;
  const body = [priceLine, shortenName(product.name), formatReview(product.reviewAverage, product.reviewCount)]
    .filter((line): line is string => line !== null)
    .join("\n");
  return `${body}\n\n${affiliateUrl}\n\n#PR`;
}

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

  const post = buildPost(product, product.affiliateUrl);

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
