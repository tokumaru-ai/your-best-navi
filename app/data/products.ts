export type Product = {
  id: number;
  name: string;
  category: string;
  description: string;
  price: number;
  score: number;
  reason: string;
  tags: string[];
  amazonUrl: string;
  rakutenUrl: string;
};

export const products: Product[] = [
  {
    id: 1,
    name: "Anker モバイルバッテリー",
    category: "ガジェット",
    description: "急速充電対応・大容量",
    price: 4980,
    score: 96,
    reason: "価格が大幅に下がりレビュー4.7の人気商品",
    tags: ["値下げ", "人気急上昇"],
    amazonUrl: "#",
    rakutenUrl: "#",
  },
  {
    id: 2,
    name: "サーモス 真空断熱タンブラー",
    category: "日用品",
    description: "一年中使える定番",
    price: 1980,
    score: 92,
    reason: "レビュー件数が多くポイント還元中",
    tags: ["ポイント10倍"],
    amazonUrl: "#",
    rakutenUrl: "#",
  },
];
