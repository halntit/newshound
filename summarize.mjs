import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSecret } from "./secrets.mjs";

const execFileAsync = promisify(execFile);

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const MAX_ITEMS_FOR_PROMPT = Number(process.env.MAX_ITEMS_FOR_PROMPT || 60);

function buildPrompt(items) {
  const capped = items.slice(0, MAX_ITEMS_FOR_PROMPT);
  const omitted = items.length - capped.length;

  const itemsBlock = capped
    .map(
      (item, i) =>
        `${i + 1}. [${item.category}] ${item.title} (source: ${item.source})\n   Link: ${item.link}\n   Original summary: ${item.summary || "(none)"}`
    )
    .join("\n\n");

  return `You are a tech news editor. Below is a list of raw IT/AI/Startup articles collected from several sources over the last 3 hours.

${itemsBlock}
${omitted > 0 ? `\n(${omitted} more articles omitted due to length limits)` : ""}

Requirements:
- Merge duplicate or near-duplicate articles into a single entry.
- Group by topic: AI, Startup, Big Tech, Viet Nam, X.com, Khac (Other) - skip any group with no items.
- Each item: one line summarizing the key point, not a verbatim copy of the original title.
- Slack mrkdwn formatting: *bold* for topic names, "- " for bullets, <link|source name> for links.
- Write the digest in Vietnamese, concise, no unnecessary emoji.
- If the list is empty: return exactly one line "Khong co tin dang chu y trong 3 tieng qua."
- Return ONLY the Slack message content, no introduction or conclusion.`;
}

/**
 * Try summarizing via headless Claude Code CLI, using subscription credentials (OAuth from 'claude setup-token').
 * Does NOT use --bare, because bare mode skips OAuth and requires ANTHROPIC_API_KEY instead.
 * Throws if the CLI is missing, not logged in, out of quota, or fails in any way - so the caller can fall back to the API.
 */
async function summarizeViaSubscription(prompt) {
  const oauthToken = getSecret("CLAUDE_CODE_OAUTH_TOKEN");
  if (!oauthToken) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not configured (run 'claude setup-token' first)");

  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken };

  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "json", "--allowedTools", ""],
    { env, timeout: 90000, maxBuffer: 10 * 1024 * 1024 }
  );

  const data = JSON.parse(stdout);
  if (data.is_error) throw new Error(`Claude Code CLI error: ${data.result || "unknown cause"}`);
  if (!data.result) throw new Error("Claude Code CLI returned no content");

  return data.result.trim();
}

/**
 * Fallback: call the Claude API directly with an API key, billed per token (pay-as-you-go).
 */
async function summarizeViaApi(prompt) {
  const apiKey = getSecret("CLAUDE_API_KEY");
  if (!apiKey) throw new Error("CLAUDE_API_KEY is not configured");

  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude API returned no text content");
  return textBlock.text.trim();
}

/**
 * Summarize the article list, preferring the subscription (Claude Code CLI) and falling back to the API on failure.
 */
export async function summarizeForSlack(items) {
  if (items.length === 0) return "Khong co tin moi trong 3 tieng qua.";

  const prompt = buildPrompt(items);

  try {
    const result = await summarizeViaSubscription(prompt);
    console.log("[summarize] Used Claude subscription (Claude Code CLI)");
    return result;
  } catch (err) {
    console.warn(`[summarize] Subscription failed (${err.message}), falling back to API...`);
  }

  return summarizeViaApi(prompt);
}
