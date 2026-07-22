import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ユア・ベストナビ",
  description: "AIが本当におすすめの商品・サービスを紹介するレビューサイト",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen bg-gray-50 text-gray-900`}
      >
        <header
          style={{
            background: "#2563eb",
            color: "white",
            padding: "20px 40px",
          }}
        >
          <h1 style={{ margin: 0 }}>ユア・ベストナビ</h1>

          <nav style={{ marginTop: "12px" }}>
            <Link
              href="/"
              style={{
                color: "white",
                marginRight: "20px",
                textDecoration: "none",
              }}
            >
              ホーム
            </Link>

            <Link
              href="/category"
              style={{
                color: "white",
                marginRight: "20px",
                textDecoration: "none",
              }}
            >
              カテゴリ
            </Link>

            <Link
              href="/smartphone"
              style={{
                color: "white",
                marginRight: "20px",
                textDecoration: "none",
              }}
            >
              スマホ
            </Link>

            <Link
              href="#"
              style={{
                color: "white",
                textDecoration: "none",
              }}
            >
              お問い合わせ
            </Link>
          </nav>
        </header>

        {children}
      </body>
    </html>
  );
}