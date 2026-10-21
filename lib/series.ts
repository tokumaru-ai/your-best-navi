// 商品名からシリーズ名（「Apple Watch Ultra 2」「iPhone 17 Pro」「AirPods Pro 3」など）を取り出す。
// 値下げの投稿を、色・バンド・容量の違う同じシリーズの商品で1投稿にまとめるために使う。
//
// 商品名だけで判定するため、ケース・バンドなどのアクセサリにも一致しうる。
// アクセサリを混ぜないよう、呼び出し側で本体と判定した商品（mainUnitReasonSql）にだけ使う。
// 判定できない商品は null を返し、商品単位のまま扱う。

// 楽天の商品名は全角英数字・全角空白が混じるため、NFKC で半角にそろえてから判定する
function normalize(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ");
}

// Apple Watch Series 10 / Apple Watch Ultra 2 / Apple Watch SE 3（「SE3」のように空白がなくてもよい）
const APPLE_WATCH_PATTERN = /Apple ?Watch ?(Series|Ultra|SE) ?(\d+)(?!\d)/i;
const APPLE_WATCH_LINES: Record<string, string> = { series: "Series", ultra: "Ultra", se: "SE" };

// iPhone 17 / iPhone 17 Pro / iPhone 17 Pro Max / iPhone 16 Plus / iPhone 17e。「eSIM」の e と取り違えないよう、e は数字の直後だけ。
const IPHONE_NUMBER_PATTERN = /iPhone ?(\d+)(e)?(?![0-9A-Za-z])(?: (Pro Max|Pro|Plus|Air|mini)(?![A-Za-z]))?/i;
// iPhone Air は番号が付かない
const IPHONE_AIR_PATTERN = /iPhone ?Air(?![A-Za-z])/i;
const IPHONE_MODELS: Record<string, string> = {
  "pro max": "Pro Max",
  pro: "Pro",
  plus: "Plus",
  air: "Air",
  mini: "mini",
};

// AirPods 4 / AirPods Pro 3 / AirPods Max 2。番号のない「AirPods Max (USB-C)」などは世代が分からないため判定しない。
const AIRPODS_PATTERN = /AirPods ?(?:(Pro|Max) ?)?(\d+)(?!\d)/i;
const AIRPODS_LINES: Record<string, string> = { pro: "Pro", max: "Max" };

export function extractSeries(name: string): string | null {
  const text = normalize(name);

  const watch = text.match(APPLE_WATCH_PATTERN);
  if (watch) return `Apple Watch ${APPLE_WATCH_LINES[watch[1].toLowerCase()]} ${watch[2]}`;

  const iphone = text.match(IPHONE_NUMBER_PATTERN);
  if (iphone) {
    const model = iphone[3] ? ` ${IPHONE_MODELS[iphone[3].toLowerCase().replace(/ +/g, " ")]}` : "";
    return `iPhone ${iphone[1]}${iphone[2] ? "e" : ""}${model}`;
  }
  if (IPHONE_AIR_PATTERN.test(text)) return "iPhone Air";

  const airpods = text.match(AIRPODS_PATTERN);
  if (airpods) {
    const line = airpods[1] ? ` ${AIRPODS_LINES[airpods[1].toLowerCase()]}` : "";
    return `AirPods${line} ${airpods[2]}`;
  }

  return null;
}
