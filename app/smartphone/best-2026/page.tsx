import Link from "next/link";

export default function Best2026Page() {
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
      <Link href="/smartphone">← スマホ一覧へ戻る</Link>

      <h1 style={{ fontSize: "36px", marginTop: "20px" }}>
        2026年おすすめスマホランキング
      </h1>

      <p style={{ color: "#6b7280" }}>
        AIが価格・性能・レビューをもとに選んだおすすめスマートフォンです。
      </p>

      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          marginTop: "30px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        }}
      >
        <h2>🥇 第1位（サンプル）</h2>

        <h3>○○スマートフォン</h3>

        <p>
          高性能CPU・長時間バッテリー・高画質カメラを搭載。
          コストパフォーマンスに優れた1台です。
        </p>

        <ul>
          <li>✅ AIおすすめ度：95点</li>
          <li>✅ コスパ：★★★★★</li>
          <li>✅ レビュー評価：4.7</li>
        </ul>

        <button
          style={{
            padding: "12px 20px",
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
          }}
        >
          Amazonで見る
        </button>
      </div>
    </main>
  );
}