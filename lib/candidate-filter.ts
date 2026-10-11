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
