export default function Home() {
  return (
    <main style={{
      maxWidth: "900px",
      margin: "0 auto",
      padding: "40px 20px",
      fontFamily: "sans-serif",
      lineHeight: "1.8"
    }}>
      <h1>ユア・ベストナビ</h1>

      <p>
        あなたにとって、本当におすすめの商品・サービス・情報を
        わかりやすく紹介するサイトです。
      </p>

      <hr />

      <h2>人気カテゴリー</h2>

      <ul>
        <li>💻 ガジェット</li>
        <li>🏠 家電</li>
        <li>📱 スマホ</li>
        <li>🏃 健康・ダイエット</li>
        <li>💰 お得情報</li>
      </ul>

      <hr />

      <h2>運営者より</h2>

      <p>
        AIを活用しながら、
        「本当に役立つ情報だけ」を発信しています。
      </p>
    </main>
  );
}