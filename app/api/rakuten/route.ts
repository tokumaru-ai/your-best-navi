import { NextResponse } from "next/server";

export async function GET() {
  const appId = process.env.RAKUTEN_APP_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  const affiliateId = process.env.RAKUTEN_AFFILIATE_ID;
  const origin = process.env.RAKUTEN_ORIGIN ?? "";

  if (!appId) {
    return NextResponse.json({
      error: "RAKUTEN_APP_ID が設定されていません",
    });
  }

  const keyword = "Anker";

  const url =
    `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701` +
    `?applicationId=${appId}` +
    `&accessKey=${accessKey}` +
    `&affiliateId=${affiliateId}` +
    `&keyword=${encodeURIComponent(keyword)}` +
    `&hits=3`;

  const res = await fetch(url, {
    headers: {
      Origin: origin,
    },
  });
  const data = await res.json();

  return NextResponse.json(data);
}
