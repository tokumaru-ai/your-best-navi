// 投稿候補の並べ替えで優先する「本体」の判定。トレンド経路・値下げ経路の両方の候補クエリで使う。
// 並べ替えてから上位を取る必要があるため、判定は SQL の式として組み込む。
//
// 判定は次の2つ（どちらにも当たらなければ本体ではない）。
//   genre:   genre_id が本体ジャンルで、商品名にAppleブランドのキーワードを含む
//   airpods: 商品名に AirPods を含み、アクセサリを示す語を含まない（genre_id が NULL でも判定できる）
// 充電器ジャンル（509433・509434）は本体扱いしない（商品名に AirPods を含む充電器も除く）。

export type MainUnitReason = "genre" | "airpods";

const MAIN_UNIT_GENRE_IDS = [
  560202, // スマートフォン本体
  564895, // スマートウォッチ本体
];

const CHARGER_GENRE_IDS = [
  509433, // モバイルバッテリー・充電器
  509434, // AC式充電器
];

// "Apple Watch" は "Apple" に含まれるが、判定条件を読みやすくするため列挙しておく
const MAIN_UNIT_BRAND_PATTERN = "(apple|iphone|apple watch|ipad)";

// AirPods の本体はヘッドホン・イヤホンジャンル（アクセサリと同じ）に分類されるため、商品名で判定する
const AIRPODS_PATTERN = "airpods";
const AIRPODS_ACCESSORY_PATTERN =
  "(ケース|カバー|イヤーピース|保護|フィルム|ストラップ|ステッカー|スキン)";

// products を alias で参照するクエリに埋め込む、本体の判定理由（'genre' | 'airpods' | NULL）を返す SQL 式。
// パターンはすべてこのファイル内の定数で、外部入力は含まない。
export function mainUnitReasonSql(alias: string): string {
  return `
    CASE
      WHEN ${alias}.genre_id IN (${MAIN_UNIT_GENRE_IDS.join(", ")})
        AND ${alias}.name ~* '${MAIN_UNIT_BRAND_PATTERN}' THEN 'genre'
      WHEN ${alias}.name ~* '${AIRPODS_PATTERN}'
        AND ${alias}.name !~* '${AIRPODS_ACCESSORY_PATTERN}'
        AND (${alias}.genre_id IS NULL OR ${alias}.genre_id NOT IN (${CHARGER_GENRE_IDS.join(", ")})) THEN 'airpods'
    END`;
}
