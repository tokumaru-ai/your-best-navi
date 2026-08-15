export type Product = {
  id: number;
  name: string;
  category: string;
  description: string;
  price: number;
  score: number;
  reason: string;
  tags: string[];
  image: string;
  amazonUrl: string;
  rakutenUrl: string;
};

export const products: Product[] = [
  {
    id: 1,
    name: "Anker モバイルバッテリー",
    category: "ガジェット",
    description: "急速充電対応・大容量で旅行や通勤にも便利。",
    price: 4980,
    score: 96,
    reason: "価格が下がりレビュー評価も非常に高い人気商品。",
    tags: ["値下げ", "人気急上昇"],
    image: "/anker.jpg",
    amazonUrl: "#",
    rakutenUrl: "#",
  },
  {
    id: 2,
    name: "サーモス 真空断熱タンブラー",
    category: "日用品",
    description: "保冷・保温に優れ一年中活躍する定番商品。",
    price: 1980,
    score: 92,
    reason: "レビュー件数が多くポイント還元中。",
    tags: ["ポイント10倍"],
    image: "/thermos.jpg",
    amazonUrl: "#",
    rakutenUrl: "#",
  },
  {
    id: 3,
    name: "Nike ランニングシューズ",
    category: "スポーツ",
    description: "初心者にもおすすめの人気ランニングシューズ。",
    price: 9980,
    score: 90,
    reason: "軽量で履き心地が良くコスパが高い。",
    tags: ["人気", "おすすめ"],
    image: "/nike.jpg",
    amazonUrl: "#",
    rakutenUrl: "#",
  },
];