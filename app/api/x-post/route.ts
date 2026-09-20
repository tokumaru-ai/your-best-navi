import { NextResponse } from "next/server";
import { TwitterApi } from "twitter-api-v2";

export async function POST(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { text } = await request.json();

    if (!text) {
      return NextResponse.json(
        { error: "投稿文がありません" },
        { status: 400 }
      );
    }

    const client = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: process.env.X_ACCESS_TOKEN!,
      accessSecret: process.env.X_ACCESS_SECRET!,
    });

    const tweet = await client.v2.tweet(text);

    return NextResponse.json({
      success: true,
      tweet: tweet.data,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Xへの投稿に失敗しました" },
      { status: 500 }
    );
  }
}