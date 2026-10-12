// 投稿候補から外す商品の判定。トレンド経路・値下げ経路の両方の候補クエリで使う。
// 取得・価格履歴の保存は続け、投稿の候補にだけしない。
//
// 回線セット: 楽天モバイルの「楽天回線セット(iPhone購入＋楽天モバイル申込)」など、
// 回線の申込が条件の商品。端末だけの値段として紹介できないため外す。
const EXCLUDED_NAME_KEYWORDS = ["回線セット"];

// products を alias で参照するクエリの WHERE に埋め込む、候補にしてよい商品かどうかの SQL 条件。
// キーワードはこのファイル内の定数で、外部入力は含まない。
export function candidateFilterSql(alias: string): string {
  return EXCLUDED_NAME_KEYWORDS.map((keyword) => `${alias}.name NOT LIKE '%${keyword}%'`).join(
    " AND "
  );
}

// 値下げ経路だけで外す、新品の正規流通品ではない（状態・流通経路が異なる）ことを示す語。
// 中古・開封品・並行輸入品などは、通常の新品と同じ商品として値下げを紹介できないため外す。
// ランクは全角英字で書かれることもあるため、両方を入れる。
const PRICE_DROP_EXCLUDED_NAME_KEYWORDS = [
  "Nランク",
  "Sランク",
  "Aランク",
  "Bランク",
  "Ｎランク",
  "Ｓランク",
  "Ａランク",
  "Ｂランク",
  "開封済",
  "展示品",
  "訳あり",
  "中古",
  "アウトレット",
  "整備済",
  "リファービッシュ",
  "海外版",
  "並行輸入",
];

// 値下げ経路の候補クエリで使う SQL 条件。共通の除外（candidateFilterSql）に、上の語の除外を加える。
export function priceDropCandidateFilterSql(alias: string): string {
  return [
    candidateFilterSql(alias),
    ...PRICE_DROP_EXCLUDED_NAME_KEYWORDS.map((keyword) => `${alias}.name NOT LIKE '%${keyword}%'`),
  ].join(" AND ");
}
