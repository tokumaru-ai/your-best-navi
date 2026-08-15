import Link from "next/link";
import { products } from "./data/products";

export default function Home() {
  const sortedProducts = [...products].sort((a, b) => b.score - a.score);

  return (
    <main
      style={{
        background: "#f3f4f6",
        minHeight: "100vh",
        maxWidth: "1100px",
        margin: "0 auto",
        padding: "40px 20px",
        color: "#111827",
      }}
    >
      <h1
        style={{
          fontSize: "46px",
          marginBottom: "10px",
          fontWeight: "bold",
        }}
      >
        🚀 ユア・ベストナビ
      </h1>

      <p
        style={{
          color: "#6b7280",
          marginBottom: "40px",
          fontSize: "18px",
        }}
      >
        AIが価格・レビュー・人気度・値下げ情報から毎日おすすめ商品をランキングしています。
      </p>

      {sortedProducts.map((product, index) => (
        <div
          key={product.id}
          style={{
            background: "#fff",
            borderRadius: "18px",
            padding: "24px",
            marginBottom: "28px",
            display: "flex",
            gap: "24px",
            alignItems: "center",
            boxShadow: "0 10px 30px rgba(0,0,0,.08)",
          }}
        >
          <img
            src={product.image}
            alt={product.name}
            style={{
              width: "220px",
              height: "160px",
              objectFit: "contain",
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: "12px",
              padding: "12px",
              flexShrink: 0,
            }}
          />

          <div style={{ flex: 1 }}>
            <div
              style={{
                display: "inline-block",
                background: "#fbbf24",
                color: "#111827",
                padding: "6px 14px",
                borderRadius: "999px",
                fontWeight: "bold",
                marginBottom: "12px",
              }}
            >
              🏆 第{index + 1}位
            </div>

            <h2 style={{ margin: "0 0 10px" }}>{product.name}</h2>

            <p style={{ color: "#4b5563" }}>{product.description}</p>

            <h3 style={{ color: "#dc2626" }}>
              ¥{product.price.toLocaleString()}
            </h3>

            <p>⭐ AIおすすめ度：{product.score}点</p>

            <p>{product.reason}</p>

            <div
              style={{
                display: "flex",
                gap: "8px",
                flexWrap: "wrap",
                margin: "18px 0",
              }}
            >
              {product.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    background: "#dbeafe",
                    color: "#2563eb",
                    padding: "6px 12px",
                    borderRadius: "999px",
                    fontWeight: "bold",
                  }}
                >
                  #{tag}
                </span>
              ))}
            </div>

            <div
              style={{
                display: "flex",
                gap: "12px",
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
        </div>
      ))}
    </main>
  );
}
