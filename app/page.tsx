export default function Home() {
  const categories = [
    "💻 ガジェット",
    "📱 スマホ",
    "🏠 家電",
    "🎧 オーディオ",
    "🏃 健康・フィットネス",
    "💰 お得情報",
  ];

  return (
    <main style={{ background: "#f8fafc", minHeight: "100vh" }}>
      <header
        style={{
          background: "#2563eb",
          color: "white",
          padding: "20px 40px",
        }}
      >
        <h1 style={{ margin: 0 }}>ユア・ベストナビ</h1>
      </header>

      <section
        style={{
          maxWidth: "1000px",
          margin: "50px auto",
          textAlign: "center",
          padding: "0 20px",
        }}
      >
        <h2 style={{ fontSize: "42px", marginBottom: "20px" }}>
          AIが、本当におすすめだけを紹介。
        </h2>

        <p style={{ color: "#555", fontSize: "18px" }}>
          ガジェット・家電・日用品などをAIが比較・調査し、
          わかりやすく紹介するレビューサイトです。
        </p>
      </section>

      <section
        style={{
          maxWidth: "1000px",
          margin: "0 auto",
          padding: "20px",
        }}
      >
        <h2>人気カテゴリー</h2>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px,1fr))",
            gap: "20px",
            marginTop: "20px",
          }}
        >
          {categories.map((item) => (
            <div
              key={item}
              style={{
                background: "white",
                borderRadius: "12px",
                padding: "24px",
                boxShadow: "0 4px 12px rgba(0,0,0,.08)",
                fontWeight: "bold",
                textAlign: "center",
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </section>

      <section
        style={{
          maxWidth: "1000px",
          margin: "60px auto",
          padding: "20px",
        }}
      >
        <h2>近日公開</h2>

        <ul style={{ lineHeight: "2" }}>
          <li>🤖 AIによる商品レビュー</li>
          <li>🛒 楽天・Amazon比較</li>
          <li>📈 ランキング</li>
          <li>🐦 X自動投稿</li>
        </ul>
      </section>

      <footer
        style={{
          background: "#111827",
          color: "#fff",
          textAlign: "center",
          padding: "30px",
          marginTop: "60px",
        }}
      >
        © 2026 ユア・ベストナビ
      </footer>
    </main>
  );
}