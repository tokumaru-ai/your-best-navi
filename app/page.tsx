import Link from "next/link";
import { products } from "./data/products";

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
      <h1 style={{ fontSize: "42px", marginBottom: "10px" }}>
        ユア・ベストナビ
      </h1>

      <p
        style={{
          color: "#6b7280",
          marginBottom: "40px",
        }}
      >
        AIが毎日、おすすめ商品を分析して紹介します。
      </p>

      <h2 style={{ marginBottom: "20px" }}>🔥 今日のおすすめ</h2>

      {products.map((product) => (
        <div
          key={product.id}
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            padding: "24px",
            marginBottom: "20px",
            boxShadow: "0 2px 10px rgba(0,0,0,.08)",
          }}
        >
          <h3>{product.name}</h3>

          <p>{product.description}</p>

          <p>
            <strong>価格：</strong>¥{product.price.toLocaleString()}
          </p>

          <p>
            <strong>AIおすすめ度：</strong>⭐ {product.score}点
          </p>

          <p>
            <strong>おすすめ理由：</strong>
            {product.reason}
          </p>

          <div
            style={{
              display: "flex",
              gap: "8px",
              flexWrap: "wrap",
              margin: "16px 0",
            }}
          >
            {product.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  background: "#dbeafe",
                  color: "#2563eb",
                  padding: "4px 10px",
                  borderRadius: "9999px",
                }}
              >
                #{tag}
              </span>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <Link
              href={`/product/${product.id}`}
              style={{
                background: "#2563eb",
                color: "#fff",
                padding: "10px 18px",
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              詳細を見る
            </Link>

            <a
              href={product.amazonUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: "#f59e0b",
                color: "#fff",
                padding: "10px 18px",
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              Amazon
            </a>

            <a
              href={product.rakutenUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: "#dc2626",
                color: "#fff",
                padding: "10px 18px",
                borderRadius: "8px",
                textDecoration: "none",
              }}
            >
              楽天
            </a>
          </div>
        </div>
      ))}
    </main>
  );
}