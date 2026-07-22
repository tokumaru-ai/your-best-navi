import Link from "next/link";

const categories = [
  {
    name: "💻 ガジェット",
    description: "PC・周辺機器・便利グッズを紹介",
  },
  {
    name: "📱 スマホ",
    description: "iPhone・Android・アクセサリー",
  },
  {
    name: "🏠 家電",
    description: "生活を便利にするおすすめ家電",
  },
  {
    name: "🎧 オーディオ",
    description: "イヤホン・ヘッドホン・スピーカー",
  },
  {
    name: "🏃 健康・フィットネス",
    description: "ダイエット・ランニング・健康グッズ",
  },
  {
    name: "💰 お得情報",
    description: "ポイント・セール・節約術",
  },
];

export default function CategoryPage() {
  return (
    <main
      style={{
        background: "#f8fafc",
        minHeight: "100vh",
        padding: "40px",
      }}
    >
      <h1
        style={{
          textAlign: "center",
          marginBottom: "40px",
        }}
      >
        カテゴリー一覧
      </h1>

      <div
        style={{
          maxWidth: "1000px",
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
          gap: "24px",
        }}
      >
        {categories.map((category) => (
          <div
            key={category.name}
            style={{
              background: "white",
              padding: "24px",
              borderRadius: "16px",
              boxShadow: "0 6px 20px rgba(0,0,0,.08)",
            }}
          >
            <h2>{category.name}</h2>

            <p style={{ color: "#666" }}>
              {category.description}
            </p>

            <Link
              href="/"
              style={{
                display: "inline-block",
                marginTop: "12px",
                color: "#2563eb",
                textDecoration: "none",
                fontWeight: "bold",
              }}
            >
              詳しく見る →
            </Link>
          </div>
        ))}
      </div>
    </main>
  );
}