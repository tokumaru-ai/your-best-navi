import { NextResponse } from "next/server";
import { ApiRequestError, ApiResponseError, TwitterApi } from "twitter-api-v2";

// 画像URLを取得してBufferに変換する。twitter-api-v2 の uploadMedia はURLを直接受け付けないため、
// ここでダウンロードしてから渡す必要がある。
async function fetchImageAsMedia(
  imageUrl: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`画像の取得に失敗しました (HTTP ${res.status}): ${imageUrl}`);
  }

  const contentType = res.headers.get("content-type")?.split(";")[0].trim();
  if (!contentType || !contentType.startsWith("image/")) {
    throw new Error(`画像のcontent-typeが不正です: ${contentType ?? "(なし)"}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType };
}

// 失敗の原因を posts.error_message・cron_runs.detail に残すため、Xが返したエラーの本文を1行にまとめる。
// エラーオブジェクトをそのまま文字列にすると、リクエスト（Authorization ヘッダーなど）が含まれうるため、
// HTTPステータスと、レスポンス本文の title・detail・errors のメッセージだけを使う。
const ERROR_DETAIL_MAX_LENGTH = 500;

function describeXError(error: unknown): string {
  let description: string;
  if (error instanceof ApiResponseError) {
    const { title, detail, error: errorText, errors } = error.data ?? {};
    const messages = (errors ?? [])
      .map((e) => ("message" in e ? e.message : undefined))
      .filter((message): message is string => !!message);
    description = [
      `HTTP ${error.code}`,
      title ? `title: ${title}` : null,
      detail ? `detail: ${detail}` : null,
      errorText ? `error: ${errorText}` : null,
      messages.length > 0 ? `errors: ${messages.join(" / ")}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", ");
  } else if (error instanceof ApiRequestError) {
    // 通信自体の失敗（レスポンスなし）。twitter-api-v2 は元の例外を requestError で読めない版があるため、読めなければ例外自体の message を使う
    description = `通信エラー: ${error.requestError?.message ?? error.message}`;
  } else {
    // 画像の取得失敗など、X API 以外の例外
    description = error instanceof Error ? error.message : String(error);
  }
  return `Xへの投稿に失敗しました（${description.slice(0, ERROR_DETAIL_MAX_LENGTH)}）`;
}

export async function POST(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { text, imageUrl } = await request.json();

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

    // imageUrl が渡された場合のみ画像を添付する。取得・アップロードに失敗した場合は
    // テキストのみでの投稿にフォールバックせず、ここで例外を投げて投稿自体を中止する。
    let mediaIds: [string] | undefined;
    if (imageUrl) {
      const { buffer, mimeType } = await fetchImageAsMedia(imageUrl);
      const mediaId = await client.v1.uploadMedia(buffer, { mimeType });
      mediaIds = [mediaId];
    }

    const tweet = await client.v2.tweet(
      text,
      mediaIds ? { media: { media_ids: mediaIds } } : undefined
    );

    return NextResponse.json({
      success: true,
      tweet: tweet.data,
    });
  } catch (error) {
    const message = describeXError(error);
    console.error(`[x-post] ${message}`);

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}