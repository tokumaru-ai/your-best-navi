import Link from "next/link";

const recommends = [
  {
    title: "🔥 今日のおすすめ",
    description: "AIが厳選した本日一番おすすめの商品",
  },
  {
    title: "💰 Amazonタイムセール",
    description: "今だけ安くなっている人気商品",
  },
  {
    title: "🎁 楽天スーパーDEAL",
    description: "ポイント還元率が高い商品",
  },
  {
    title: "📉 値下げ商品",
    description: "価格が下がった狙い目の商品",
  },
];

export default function Home() {
  return (
    <main
      style={{
        background: "#f8fafc",
        minHeight: "100vh",
        maxWidth: "1000px",
        margin: "0 auto",
        padding: "40px 20px",
        color: "#111827",
      }}
    >
      <h1 style={{ fontSize: "42px" }}>
        ユア・ベストナビ
      </h1>

      <p style={{ color: "#6b7280", marginBottom: "40px" }}>
        AIが毎日おすすめ商品を分析して紹介します。
      </p>

      {recommends.map((item) => (
        <div
          key={item.title}
          style={{
            background: "#fff",
            borderRadius: "12px",
            padding: "24px",
            marginBottom: "20px",
            boxShadow: "0 2px 10px rgba(0,0,0,.08)",
          }}
        >
          <h2>{item.title}</h2>

          <p>{item.description}</p>

          <button
            style={{
              background: "#2563eb",
              color: "#fff",
              border: "none",
              padding: "10px 18px",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            見る
          </button>
        </div>
      ))}

      <div style={{ marginTop: "40px" }}>
        <Link href="/category">
          カテゴリー一覧 →
        </Link>
      </div>
    </main>
  );
}