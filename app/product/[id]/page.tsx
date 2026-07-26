import Link from "next/link";
import { products } from "../../data/products";

type Props = {
  params: Promise<{
    id: string;
  }>;
};

export default async function ProductPage({ params }: Props) {
  const { id } = await params;

  const product = products.find((p) => p.id === Number(id));

  if (!product) {
    return (
      <main style={{ padding: "40px" }}>
        <h1>商品が見つかりません</h1>
        <Link href="/">ホームへ戻る</Link>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: "900px",
        margin: "0 auto",
        padding: "40px 20px",
      }}
    >
      <Link href="/">← ホームへ戻る</Link>

      <h1 style={{ marginTop: "20px" }}>{product.name}</h1>

      <p>{product.description}</p>

      <h2>価格：¥{product.price.toLocaleString()}</h2>

      <p>⭐ AIおすすめ度：{product.score}点</p>

      <p>
        <strong>おすすめ理由：</strong>
        {product.reason}
      </p>

      <div
        style={{
          display: "flex",
          gap: "10px",
          flexWrap: "wrap",
          margin: "20px 0",
        }}
      >
        {product.tags.map((tag) => (
          <span
            key={tag}
            style={{
              background: "#dbeafe",
              color: "#2563eb",
              padding: "5px 12px",
              borderRadius: "999px",
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
        }}
      >
        <a href={product.amazonUrl}>Amazonで見る</a>

        <a href={product.rakutenUrl}>楽天で見る</a>
      </div>
    </main>
  );
}