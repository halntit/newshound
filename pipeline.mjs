import crypto from "node:crypto";
import { listSources, getSetting, filterUnseen, markSeen, cleanupOldSeenLinks } from "./db.mjs";
import { getSecret } from "./secrets.mjs";
import { fetchAllNews } from "./fetchNews.mjs";
import { summarizeForSlack } from "./summarize.mjs";
import { postToSlack } from "./slack.mjs";

const linkHash = (link) => crypto.createHash("sha256").update(link).digest("hex");

async function main() {
  const startedAt = Date.now();

  const sources = listSources();
  const xAccounts = getSetting("x_accounts", []);
  const xBearerToken = getSecret("X_BEARER_TOKEN");
  const slackWebhookUrl = getSecret("SLACK_WEBHOOK_URL");

  console.log(`[pipeline] ${sources.length} RSS sources, ${xAccounts.length} X accounts`);

  const rawItems = await fetchAllNews({ sources, xAccounts, xBearerToken });
  const newItems = filterUnseen(rawItems, linkHash);
  console.log(`[pipeline] ${newItems.length}/${rawItems.length} items are new`);

  if (newItems.length === 0) {
    console.log("[pipeline] No new items, skipping Slack post");
    cleanupOldSeenLinks(Number(process.env.DEDUPE_TTL_HOURS || 48));
    return;
  }

  const summary = await summarizeForSlack(newItems);
  await postToSlack(slackWebhookUrl, summary, { itemCount: newItems.length });
  markSeen(newItems, linkHash);

  // Clean up old dedupe records - replaces DynamoDB's automatic TTL
  const removed = cleanupOldSeenLinks(Number(process.env.DEDUPE_TTL_HOURS || 48));
  if (removed > 0) console.log(`[pipeline] Cleaned up ${removed} old dedupe records`);

  console.log(`[pipeline] Done in ${Date.now() - startedAt}ms, posted ${newItems.length} items`);
}

// Exit explicitly: rss-parser can leave sockets open (unread redirect bodies, timed-out requests)
// that would otherwise keep this cron process alive long after the work is done
main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[pipeline] Unhandled error: ${err.stack || err.message}`);
    process.exit(1); // non-zero exit code so cron/logs can spot a failed run
  }
);
