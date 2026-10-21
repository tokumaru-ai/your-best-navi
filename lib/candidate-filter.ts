// 投稿候補から外す商品の判定。トレンド経路・値下げ経路の両方の候補クエリで使う。
// 取得・価格履歴の保存は続け、投稿の候補にだけしない。
//
// 価格・特典に条件が付いている商品を外す。商品名の価格だけでは、条件なしで買える値段として紹介できないため。
// - 回線・乗り換え・申込: 楽天モバイルの「楽天回線セット(iPhone購入＋楽天モバイル申込)」など、回線の申込が条件の商品
// - 条件・条件達成・エントリー・ポイント: 「条件達成で3300ポイント」など、条件の中身が商品名から分からない特典付きの商品
// 「ポイント」は「マルチポイント接続」などの仕様にも一致するが、条件付きの特典と見分けられないため、まとめて外す。
const EXCLUDED_NAME_KEYWORDS = ["条件", "回線", "乗り換え", "申込", "エントリー", "ポイント"];

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

// 値下げ経路だけで外す、購入に条件・制限が付いていることを示す語。
// 「機種変更はこちら」「本人確認必須」「自宅受け取り限定」など、誰でも商品名の価格で買えるとは限らない商品を、値下げとして紹介しないため外す。
// 共通の除外（EXCLUDED_NAME_KEYWORDS）と重なる語も、値下げ経路の条件として一覧で読めるよう、ここにも入れる。
// 「限定」は「期間限定セール」などにも一致するが、購入の制限と見分けられないため、まとめて外す。
const PRICE_DROP_CONDITION_KEYWORDS = [
  "機種変更",
  "本人確認",
  "条件達成",
  "条件",
  "回線",
  "乗り換え",
  "申込",
  "エントリー",
  "ポイント",
  "契約",
  "限定",
];

// 値下げ経路の候補クエリで使う SQL 条件。共通の除外（candidateFilterSql）に、上の2つの語の一覧の除外を加える。
export function priceDropCandidateFilterSql(alias: string): string {
  return [
    candidateFilterSql(alias),
    ...[...PRICE_DROP_EXCLUDED_NAME_KEYWORDS, ...PRICE_DROP_CONDITION_KEYWORDS].map(
      (keyword) => `${alias}.name NOT LIKE '%${keyword}%'`
    ),
  ].join(" AND ");
}
