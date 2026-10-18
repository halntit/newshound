import Parser from "rss-parser";

const parser = new Parser({ timeout: 10000 });
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS || 3.5);
const MAX_X_ACCOUNTS_PER_QUERY = 25;

const HN_SOURCE = { name: "Hacker News (top stories)", category: "International" };

async function fetchRssFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;

    return (feed.items || [])
      .filter((item) => {
        const pubDate = item.isoDate ? new Date(item.isoDate).getTime() : null;
        return pubDate === null || pubDate >= cutoff;
      })
      .map((item) => ({
        title: (item.title || "").trim(),
        link: item.link || item.guid,
        summary: (item.contentSnippet || item.summary || "").replace(/\s+/g, " ").trim().slice(0, 500),
        source: source.name,
        category: source.category,
      }))
      .filter((item) => item.title && item.link);
  } catch (err) {
    console.error(`[fetchRssFeed] Error in ${source.name}: ${err.message}`);
    return [];
  }
}

async function fetchHackerNews() {
  try {
    const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${since}&hitsPerPage=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    return (data.hits || [])
      .filter((hit) => hit.points >= 30)
      .map((hit) => ({
        title: hit.title || "",
        link: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        summary: `${hit.points} points, ${hit.num_comments} comments on Hacker News`,
        source: HN_SOURCE.name,
        category: HN_SOURCE.category,
      }))
      .filter((item) => item.title && item.link);
  } catch (err) {
    console.error(`[fetchHackerNews] Error: ${err.message}`);
    return [];
  }
}

async function fetchX(xAccounts, bearerToken) {
  if (!xAccounts?.length || !bearerToken) return [];

  const accountsBatch = xAccounts.slice(0, MAX_X_ACCOUNTS_PER_QUERY);
  const query = accountsBatch.map((h) => `from:${h}`).join(" OR ");
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

  const url = new URL("https://api.twitter.com/2/tweets/search/recent");
  url.searchParams.set("query", `(${query}) -is:retweet`);
  url.searchParams.set("start_time", since);
  url.searchParams.set("max_results", "50");
  url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username");

  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${bearerToken}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = await res.json();
    const usersById = Object.fromEntries((data.includes?.users || []).map((u) => [u.id, u.username]));

    return (data.data || []).map((tweet) => {
      const username = usersById[tweet.author_id] || "unknown";
      return {
        title: tweet.text.slice(0, 200).replace(/\s+/g, " "),
        link: `https://x.com/${username}/status/${tweet.id}`,
        summary: `${tweet.public_metrics?.like_count ?? 0} likes, ${tweet.public_metrics?.reply_count ?? 0} replies`,
        source: `X @${username}`,
        category: "X.com",
      };
    });
  } catch (err) {
    console.error(`[fetchX] Error: ${err.message}`);
    return [];
  }
}

export async function fetchAllNews({ sources, xAccounts, xBearerToken }) {
  const results = await Promise.allSettled([
    ...sources.map(fetchRssFeed),
    fetchHackerNews(),
    fetchX(xAccounts, xBearerToken),
  ]);
  const items = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  console.log(`[fetchAllNews] Collected ${items.length} raw items from ${sources.length + 2} sources`);
  return items;
}
