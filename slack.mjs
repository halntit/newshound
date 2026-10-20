const now = () => new Date().toLocaleString("vi-VN", { timeZone: process.env.TIMEZONE || "Asia/Ho_Chi_Minh" });

const SECTION_TEXT_LIMIT = 3000; // character limit of one Slack section block
const MAX_BLOCKS = 50; // block limit of one Slack message

// Split on lines so a <link|name> is never cut; only an over-long single line gets hard-truncated
function splitIntoSections(text) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= SECTION_TEXT_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line.slice(0, SECTION_TEXT_LIMIT);
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function postToSlack(webhookUrl, summaryText, meta = {}) {
  if (!webhookUrl) throw new Error("Slack webhook URL is not configured");

  const header = `*Ban tin IT / AI / Startup - ${now()}*` + (meta.itemCount != null ? ` _(${meta.itemCount} tin moi)_` : "");
  const sections = splitIntoSections(summaryText).slice(0, MAX_BLOCKS - 2);
  const payload = {
    text: header, // fallback for notifications/push
    unfurl_links: false, // no link previews under the digest
    unfurl_media: false,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header } },
      { type: "divider" },
      ...sections.map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
}
