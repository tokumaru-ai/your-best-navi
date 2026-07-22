import Link from "next/link";

const articles = [
  {
    title: "2026年おすすめスマホランキング",
    summary: "AIが価格・性能・口コミを比較しておすすめを紹介します。",
  },
  {
    title: "iPhoneとAndroidどっちを選ぶ？",
    summary: "初心者にもわかりやすく違いを解説します。",
  },
  {
    title: "コスパ最強スマホ5選",
    summary: "5万円以下で買えるおすすめスマホを厳選。",
  },
];

export default function SmartphonePage() {
  return (
    <main
      style={{
        background: "#f8fafc",
        minHeight: "100vh",
        maxWidth: "900px",
        margin: "0 auto",
        padding: "40px 20px",
        color: "#111827",
      }}
    >
      <Link
        href="/category"
        style={{
          textDecoration: "none",
          color: "#2563eb",
        }}
      >
        ← カテゴリー一覧へ戻る
      </Link>

      <h1 style={{ marginTop: "20px", color: "#111827" }}>
        📱 スマホ記事一覧
      </h1>

      {articles.map((article) => (
        <div
          key={article.title}
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "20px",
            marginTop: "20px",
            boxShadow: "0 4px 12px rgba(0,0,0,.08)",
          }}
        >
          <h2
            style={{
              color: "#111827",
              marginBottom: "10px",
            }}
          >
            {article.title}
          </h2>

          <p
            style={{
              color: "#4b5563",
              lineHeight: "1.6",
            }}
          >
            {article.summary}
          </p>
        </div>
      ))}
    </main>
  );
}