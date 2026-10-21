import { getSql } from "@/lib/db";
import { mainUnitReasonSql } from "@/lib/main-unit";
import type { ScoredRow } from "@/lib/price-drop-candidates";
import { extractSeries } from "@/lib/series";

// 値下げ経路の候補（候補条件をすべて通った商品）を、シリーズごとにまとめた1投稿分。
export type SeriesGroup = {
  // シリーズ名。本体でない商品、シリーズを判定できない商品は null で、その商品1件だけのグループになる
  series: string | null;
  // 候補条件を通った、このシリーズの商品（候補の並び順のまま）
  products: ScoredRow[];
  // 値下げ額が最大の商品。返信のリンクと画像に使う
  representative: ScoredRow;
  previousMinPrice: number;
  previousMaxPrice: number;
  currentMinPrice: number;
  currentMaxPrice: number;
  previousFetchedFrom: Date;
  previousFetchedTo: Date;
  currentFetchedFrom: Date;
  currentFetchedTo: Date;
};

// アクセサリ（「iPhone 17 Pro ケース」など）をシリーズに混ぜないよう、本体と判定した商品だけをシリーズでまとめる
function seriesOf(row: Pick<ScoredRow, "name" | "mainUnitReason">): string | null {
  return row.mainUnitReason ? extractSeries(row.name) : null;
}

// 値下げ額が大きい順。同じなら値下げ率の高い順、それも同じなら id の小さい順（毎回同じ商品を選ぶため）
function isBetterRepresentative(a: ScoredRow, b: ScoredRow): boolean {
  if (a.dropAmount !== b.dropAmount) return a.dropAmount > b.dropAmount;
  const rateA = a.dropAmount / a.previousPrice;
  const rateB = b.dropAmount / b.previousPrice;
  if (rateA !== rateB) return rateA > rateB;
  return a.id < b.id;
}

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const minDate = (dates: Date[]) => new Date(Math.min(...dates.map((d) => d.getTime())));
const maxDate = (dates: Date[]) => new Date(Math.max(...dates.map((d) => d.getTime())));

// 候補を、シリーズごとにまとめる。グループの並びは、各グループで最初に出てくる商品の、候補の並び順（本体 > それ以外、値下げ率の高い順）。
export function groupBySeries(rows: ScoredRow[]): SeriesGroup[] {
  const byKey = new Map<string, { series: string | null; products: ScoredRow[] }>();
  for (const row of rows) {
    const series = seriesOf(row);
    const key = series ?? `product:${row.id}`;
    const group = byKey.get(key) ?? { series, products: [] };
    group.products.push(row);
    byKey.set(key, group);
  }

  return [...byKey.values()].map(({ series, products }) => {
    const previousPrices = products.map((p) => p.previousPrice);
    const currentPrices = products.map((p) => p.currentPrice);
    const previousDates = products.map((p) => toDate(p.previousFetchedAt));
    const currentDates = products.map((p) => toDate(p.currentFetchedAt));
    return {
      series,
      products,
      representative: products.reduce((best, p) => (isBetterRepresentative(p, best) ? p : best)),
      previousMinPrice: Math.min(...previousPrices),
      previousMaxPrice: Math.max(...previousPrices),
      currentMinPrice: Math.min(...currentPrices),
      currentMaxPrice: Math.max(...currentPrices),
      previousFetchedFrom: minDate(previousDates),
      previousFetchedTo: maxDate(previousDates),
      currentFetchedFrom: minDate(currentDates),
      currentFetchedTo: maxDate(currentDates),
    };
  });
}

// DBにある本体の商品を、シリーズ名ごとの商品IDにまとめる。重複防止（dedupProductIds）に使う。
export async function loadSeriesProductIds(): Promise<Map<string, number[]>> {
  const rows = (await getSql().query(
    `SELECT p.id, p.name FROM products p WHERE (${mainUnitReasonSql("p")}) IS NOT NULL`
  )) as { id: number; name: string }[];
  const bySeries = new Map<string, number[]>();
  for (const row of rows) {
    const series = extractSeries(row.name);
    if (series === null) continue;
    bySeries.set(series, [...(bySeries.get(series) ?? []), row.id]);
  }
  return bySeries;
}

// 重複防止（post_dedup）で扱う商品ID。シリーズのグループは、候補に残っていない商品も含めて、
// DBにあるそのシリーズの本体すべてを返す（その日に値下げしていない色・容量の商品から、同じシリーズが再び出ないように）。
export function dedupProductIds(group: SeriesGroup, seriesProductIds: Map<string, number[]>): number[] {
  const ids = new Set(group.products.map((p) => p.id));
  if (group.series !== null) {
    for (const id of seriesProductIds.get(group.series) ?? []) ids.add(id);
  }
  return [...ids];
}
