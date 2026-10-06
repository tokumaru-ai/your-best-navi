import { NextResponse } from "next/server";
import { TwitterApi } from "twitter-api-v2";
import { ensureSchema, getPool } from "@/lib/db";

// Apple製品・周辺機器に絞り込む。表記ゆれ（スペース有無・カタカナ/英字）はORでまとめて拾う。
const KEYWORDS = [
  "(iPhoneケース OR iPhone ケース)",
  "AirPods",
  "(Apple Watch OR アップルウォッチ)",
];
const MAX_RESULTS = 20;
// min_likes は X API の検索演算子（Standalone、recent search で利用可）。
// Web検索のmin_faves/min_retweetsはAPIでは無効な名称のため、min_likes/min_repostsを使う。
// API側で事前に足切りすることで、反応の弱い投稿を取得前に除外する。
const MIN_LIKES = 10;

type SearchedTweet = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    quote_count: number;
  };
};

type KeywordResult = {
  keyword: string;
  fetched: number;
  saved: number;
  error?: string;
};

function reactionScore(metrics?: SearchedTweet["public_metrics"]): number {
  if (!metrics) return 0;
  return (
    metrics.like_count +
    metrics.retweet_count * 2 +
    metrics.reply_count +
    metrics.quote_count * 2
  );
}

async function searchKeyword(
  client: TwitterApi,
  keyword: string
): Promise<SearchedTweet[]> {
  // id, text はAPI既定で返るが、created_at・public_metrics・author_id は
  // tweet.fields で明示しないと返らない
  const result = await client.v2.search(`${keyword} -is:retweet min_likes:${MIN_LIKES}`, {
    max_results: MAX_RESULTS,
    "tweet.fields": ["public_metrics", "created_at", "author_id"],
  });

  return result.tweets as SearchedTweet[];
}

async function saveTweets(tweets: SearchedTweet[]): Promise<number> {
  if (tweets.length === 0) return 0;

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    for (const tweet of tweets) {
      await client.query(
        `
        INSERT INTO x_trending_posts
          (post_id, text, author_id, like_count, retweet_count, reply_count, quote_count, reaction_score, created_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (post_id) DO UPDATE SET
          text           = excluded.text,
          author_id      = excluded.author_id,
          like_count     = excluded.like_count,
          retweet_count  = excluded.retweet_count,
          reply_count    = excluded.reply_count,
          quote_count    = excluded.quote_count,
          reaction_score = excluded.reaction_score,
          created_at     = excluded.created_at,
          fetched_at     = now()
        `,
        [
          tweet.id,
          tweet.text,
          tweet.author_id ?? null,
          tweet.public_metrics?.like_count ?? null,
          tweet.public_metrics?.retweet_count ?? null,
          tweet.public_metrics?.reply_count ?? null,
          tweet.public_metrics?.quote_count ?? null,
          reactionScore(tweet.public_metrics),
          tweet.created_at ?? null,
        ]
      );
      // extracted_product_name / extraction_confidence は ON CONFLICT で触らない。
      // 抽出済みの投稿が再度ヒットしても、抽出結果を消さないため。
    }

    await client.query("COMMIT");
    return tweets.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function GET(request: Request) {
  const secret = process.env.X_POST_SECRET;
  if (!secret || request.headers.get("x-api-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });

  const results: KeywordResult[] = [];

  for (const keyword of KEYWORDS) {
    try {
      const tweets = await searchKeyword(client, keyword);
      const saved = await saveTweets(tweets);
      results.push({ keyword, fetched: tweets.length, saved });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[x-trending/fetch] "${keyword}" failed: ${message}`);
      results.push({ keyword, fetched: 0, saved: 0, error: message });
    }
  }

  return NextResponse.json({
    saved: results.reduce((sum, r) => sum + r.saved, 0),
    errors: results.filter((r) => r.error).length,
    results,
  });
}
