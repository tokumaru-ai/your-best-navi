import { NextResponse } from "next/server";

export async function GET() {
  const appId = process.env.RAKUTEN_APP_ID;

  if (!appId) {
    return NextResponse.json({
      error: "RAKUTEN_APP_ID が設定されていません",
    });
  }

  const keyword = "Anker";

  const url =
    `https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601` +
    `?applicationId=${appId}` +
    `&keyword=${encodeURIComponent(keyword)}` +
    `&hits=3`;

  const res = await fetch(url);
  const data = await res.json();

  return NextResponse.json(data);
}
