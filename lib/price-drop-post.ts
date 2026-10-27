// 値下げ経路の投稿文。生成AIを使わず、取得した実データ（価格・取得日時・レビュー）だけからテンプレートで組み立てる。
// 「Xで話題」「人気」など、取得していない根拠が文中に入らないようにするため。
// 値下げは「定価からの値引き」ではなく「前回取得時からの変化」なので、2回分の取得日時を必ず書く。

import type { MainUnitReason } from "@/lib/main-unit";

export type PriceDropPostInput = {
  name: string;
  currentPrice: number;
  previousPrice: number;
  // price_history の直近2件の fetched_at（ISO文字列）
  currentFetchedAt: string;
  previousFetchedAt: string;
  // 最安値の比較に使った price_history の記録の日数（今回を除き、JSTの日付で重複を除く）。今回の価格はこれらの最安値を下回っている
  comparedDays: number;
  reviewAverage: number | null;
  reviewCount: number | null;
  // 本体の判定（mainUnitReasonSql）。本体は商品名の下限文字数（NAME_MIN_LENGTH）を使わない
  mainUnitReason: MainUnitReason | null;
};

// 投稿に載せる商品名の上限文字数（末尾の「…」を除く）。楽天の商品名は検索用キーワードが長く続くため、先頭だけを使う。
const NAME_MAX_LENGTH = 30;
// 宣伝文句・【】を取り除いた商品名がこれより短い商品は、何の商品か分かる名前にならないため候補にしない。
// 本体（iPhone・Apple Watch・AirPods など）は「Apple AirPods Pro 3」のように短い名前でも何の商品か分かるため、使わない。
const NAME_MIN_LENGTH = 20;
// 区切りで切るとき、これより短くなる位置では切らない。上限以内にこの長さ以上で切れる区切りがなければ、候補にしない
const NAME_MIN_CUT_LENGTH = 15;
// 比較した記録がこの日数分に満たないときは、「最安値」と書く根拠が足りないため投稿しない（score でも候補から外している）
const MIN_COMPARED_DAYS = 3;
// レビューはこの件数以上のときだけ書く。件数が少ない評価は参考にならないため。
const MIN_REVIEW_COUNT = 10;

// 「【…】」の括弧書きは、中身によらずすべて取り除く。販売条件・宣伝文句・状態の表記が混在し、商品名の本体ではないため。
const LENTICULAR_BRACKET_SEGMENT = /【[^】]*】/g;
// それ以外の括弧で囲まれた部分のうち、販売条件（送料・ポイント・発送日・クーポンなど）や、
// こちらで確かめていない宣伝文句（楽天1位・ランキングなど）を書いたものを取り除く。
// 状態を示す語（新品・未開封・正規品など）を含む括弧や、どちらか判断できない括弧は残す。
const BRACKETED_SEGMENT = /［[^］]*］|\[[^\]]*\]|《[^》]*》|≪[^≫]*≫|＜[^＞]*＞/g;
// 商品名の先頭の宣伝文句。「！」「!」で終わる文（「新発売!!」「クーポンで最安3,380円！」など）と、「＼…／」で囲んだ文句。
// 先頭から順に、続けて書かれたものをすべて取り除く。
const LEADING_PROMO = /^(?:＼[^／]*／|[^！!]*[！!]+)/;
// 宣伝文句を取り除いた後、先頭に残る記号
const LEADING_LEFTOVER = /^[\s＼／]+/;
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

// 商品名を切ってよい位置の判定に使う文字。区切り記号の後ろ、開き括弧の前、閉じ括弧の後ろで切る。
// 「/」「+」は型番（MFHP4J/A）や仕様（Wi-Fi+Cellular）の中にも出るため、区切りにしない。
const SEPARATORS = new Set([" ", "・", "、", "，", ",", "|", "｜"]);
const OPENING_BRACKETS = new Set(["【", "［", "[", "《", "≪", "＜", "(", "（", "「"]);
const CLOSING_BRACKETS = new Set(["】", "］", "]", "》", "≫", "＞", ")", "）", "」"]);

function isSalesConditionOnly(segment: string): boolean {
  return (
    SALES_CONDITION_PATTERNS.some((pattern) => pattern.test(segment)) &&
    !ITEM_STATE_KEYWORDS.some((keyword) => segment.includes(keyword))
  );
}

// 各位置（i 文字目の直前）が括弧の内側かどうか。括弧の中で切ると閉じ括弧が欠けるため、そこでは切らない。
function bracketDepths(text: string): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = 0; i <= text.length; i++) {
    depths.push(depth);
    const char = text[i];
    if (OPENING_BRACKETS.has(char)) depth++;
    else if (CLOSING_BRACKETS.has(char)) depth = Math.max(0, depth - 1);
  }
  return depths;
}

// index の位置（index 文字目の直前）で切っても、単語の途中・括弧の内側にならないか
function isBreakPosition(text: string, index: number, depths: number[]): boolean {
  if (depths[index] !== 0) return false;
  const before = text[index - 1];
  const after = text[index];
  return (
    SEPARATORS.has(before) ||
    SEPARATORS.has(after) ||
    OPENING_BRACKETS.has(after) ||
    CLOSING_BRACKETS.has(before)
  );
}

// 切った後ろに残る区切り記号・空白を落とす
function trimTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && SEPARATORS.has(text[end - 1])) end--;
  return text.slice(0, end);
}

// 先頭の宣伝文句を、続けて書かれたものも含めて取り除く。取り除くと何も残らない場合は、そこで止める
function removeLeadingPromo(text: string): string {
  let rest = text;
  for (;;) {
    const match = rest.match(LEADING_PROMO);
    if (!match) return rest;
    const next = rest.slice(match[0].length).replace(LEADING_LEFTOVER, "");
    if (next === "") return rest;
    rest = next;
  }
}

// 投稿に載せる商品名。先頭の宣伝文句・【】・販売条件の括弧を取り除き、NAME_MAX_LENGTH 文字以内の区切りで切る。
// 取り除いた後が NAME_MIN_LENGTH 文字未満の場合（本体は空の場合だけ）と、単語の途中で切らずに上限以内に収められない場合は null（候補にしない）。
export function shortenName(name: string, isMainUnit: boolean): string | null {
  const cleaned = name
    .replace(LENTICULAR_BRACKET_SEGMENT, " ")
    .replace(BRACKETED_SEGMENT, (segment) => (isSalesConditionOnly(segment) ? " " : segment))
    .replace(/[★☆◆◇■□●○♪]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = trimTrailingSeparators(removeLeadingPromo(cleaned).trim());
  if (base.length < (isMainUnit ? 1 : NAME_MIN_LENGTH)) return null;
  if (base.length <= NAME_MAX_LENGTH) return base;

  // 上限以内で最も後ろの区切りで切る
  const depths = bracketDepths(base);
  for (let i = NAME_MAX_LENGTH; i >= NAME_MIN_CUT_LENGTH; i--) {
    if (isBreakPosition(base, i, depths)) return `${trimTrailingSeparators(base.slice(0, i))}…`;
  }
  return null;
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

const JST_DATE_HOUR = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23",
});

// 取得日時を JST の「10/11 21時」の形にする。日時として読めなければ null。
export function formatFetchedAt(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    JST_DATE_HOUR.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.month}/${parts.day} ${parts.hour}時`;
}

// 「記録のある○日分の中で最安値」。score が「今回の価格 < 比較した記録（今回を除く）の最安値」で絞った商品だけに書く。
function formatLowestPriceLine(comparedDays: number): string | null {
  if (!Number.isInteger(comparedDays) || comparedDays < MIN_COMPARED_DAYS) return null;
  return `記録のある${comparedDays}日分の中で最安値`;
}

// レビューは件数が MIN_REVIEW_COUNT 件以上のときだけ書く
function formatReview(reviewAverage: number | null, reviewCount: number | null): string | null {
  if (reviewCount === null || reviewCount < MIN_REVIEW_COUNT) return null;
  const count = `${reviewCount.toLocaleString("ja-JP")}件`;
  return reviewAverage !== null && reviewAverage > 0
    ? `レビュー評価${reviewAverage}（${count}）`
    : `レビュー${count}`;
}

// 取得日時を読めない場合、比較した記録が MIN_COMPARED_DAYS 日分に満たない場合、商品名を作れない場合は null を返す（根拠なしでは投稿しない）
export function buildPriceDropPost(product: PriceDropPostInput, affiliateUrl: string): string | null {
  const previousAt = formatFetchedAt(product.previousFetchedAt);
  const currentAt = formatFetchedAt(product.currentFetchedAt);
  const lowestPriceLine = formatLowestPriceLine(product.comparedDays);
  const name = shortenName(product.name, product.mainUnitReason !== null);
  if (!previousAt || !currentAt || !lowestPriceLine || !name) return null;

  const priceLine = `${formatYen(product.previousPrice)} → ${formatYen(product.currentPrice)}（${formatDropRate(
    product.previousPrice,
    product.currentPrice
  )}OFF）`;
  const fetchedLine = `${previousAt} ${formatYen(product.previousPrice)} → ${currentAt} ${formatYen(product.currentPrice)}`;
  const body = [
    priceLine,
    fetchedLine,
    lowestPriceLine,
    name,
    formatReview(product.reviewAverage, product.reviewCount),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return `${body}\n\n${affiliateUrl}\n\n#PR`;
}

// シリーズでまとめた値下げの投稿。返信なしの1つの投稿にする。
// 1行目に #PR を書き、取得した値（シリーズ名・種類の数・前回と今回の価格帯・取得日時）と、
// 代表商品（値下げ額が最大）のアフィリエイトリンク1本だけを書く。
export type SeriesPostInput = {
  // シリーズ名。null のときは、その商品1件だけの投稿として商品名を使う
  series: string | null;
  productCount: number;
  representativeName: string;
  // 代表商品が本体かどうか。本体は商品名の下限文字数（NAME_MIN_LENGTH）を使わない
  representativeIsMainUnit: boolean;
  affiliateUrl: string;
  previousMinPrice: number;
  previousMaxPrice: number;
  currentMinPrice: number;
  currentMaxPrice: number;
  // 取得日時（ISO文字列または Date）。シリーズ内で異なる場合は最も古いものから新しいものまでを書く
  previousFetchedFrom: string | Date;
  previousFetchedTo: string | Date;
  currentFetchedFrom: string | Date;
  currentFetchedTo: string | Date;
};

const SERIES_POST_NOTE = "条件・在庫は商品ページで確認";

function formatPriceRange(min: number, max: number): string {
  return min === max ? formatYen(min) : `${formatYen(min)}〜${formatYen(max)}`;
}

// 取得日時の範囲。同じ表示になるなら1つだけ書く。読めなければ null
function formatFetchedRange(from: string | Date, to: string | Date): string | null {
  const fromText = formatFetchedAt(new Date(from).toISOString());
  const toText = formatFetchedAt(new Date(to).toISOString());
  if (!fromText || !toText) return null;
  return fromText === toText ? fromText : `${fromText}〜${toText}`;
}

// 取得日時を読めない場合、商品名を作れない場合は null を返す（根拠なしでは投稿しない）
export function buildSeriesPost(input: SeriesPostInput): string | null {
  const previousAt = formatFetchedRange(input.previousFetchedFrom, input.previousFetchedTo);
  const currentAt = formatFetchedRange(input.currentFetchedFrom, input.currentFetchedTo);
  const title =
    input.series !== null
      ? `${input.series}（${input.productCount}種類）`
      : shortenName(input.representativeName, input.representativeIsMainUnit);
  if (!previousAt || !currentAt || !title) return null;

  return [
    "#PR",
    title,
    `${formatPriceRange(input.previousMinPrice, input.previousMaxPrice)} → ${formatPriceRange(
      input.currentMinPrice,
      input.currentMaxPrice
    )}`,
    `取得 ${previousAt}→${currentAt}`,
    SERIES_POST_NOTE,
    input.affiliateUrl,
  ].join("\n");
}
