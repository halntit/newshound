import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSources, addSource, deleteSource, getSetting, setSetting } from "./db.mjs";
import { writeSecret, isSecretSet, getSecret } from "./secrets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Simple auth with one shared key - suitable for a single-user personal/internal tool
// Read on every request (not cached) so editing .env by hand doesn't require a server restart
function requireAuth(req, res, next) {
  const DASHBOARD_KEY = getSecret("DASHBOARD_API_KEY");
  if (!DASHBOARD_KEY || !safeEqual(req.headers["x-dashboard-key"], DASHBOARD_KEY)) {
    return res.status(401).json({ error: "Missing or invalid x-dashboard-key" });
  }
  next();
}

// Constant-time comparison: hash first so both buffers have equal length for timingSafeEqual
function safeEqual(a, b) {
  if (typeof a !== "string") return false;
  const hash = (v) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

// Valid X handle: letters, digits, _ (max 15 chars) - also blocks injecting operators into the X search query
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

app.get("/api/sources", requireAuth, (req, res) => {
  res.json(listSources());
});

app.post("/api/sources", requireAuth, (req, res) => {
  const { name, url, category } = req.body || {};
  if (!name || !url || !category) return res.status(400).json({ error: "Missing name, url, or category" });
  if (!isHttpUrl(url)) return res.status(400).json({ error: "URL must start with http:// or https://" });
  res.status(201).json(addSource({ name, url, category }));
});

app.delete("/api/sources/:id", requireAuth, (req, res) => {
  deleteSource(req.params.id);
  res.status(204).end();
});

app.get("/api/settings", requireAuth, (req, res) => {
  res.json({
    x_accounts: getSetting("x_accounts", []),
    slack_webhook_set: isSecretSet("SLACK_WEBHOOK_URL"),
    x_token_set: isSecretSet("X_BEARER_TOKEN"),
    claude_api_key_set: isSecretSet("CLAUDE_API_KEY"),
    claude_subscription_set: isSecretSet("CLAUDE_CODE_OAUTH_TOKEN"),
  });
});

app.put("/api/settings", requireAuth, (req, res) => {
  const { x_accounts, slack_webhook_url, x_bearer_token, claude_api_key, claude_code_oauth_token } = req.body || {};

  if (x_accounts !== undefined) {
    if (!Array.isArray(x_accounts) || !x_accounts.every((h) => typeof h === "string" && X_HANDLE_RE.test(h)))
      return res.status(400).json({ error: "x_accounts must be an array of valid X handles (letters, digits, _; max 15 characters)" });
    setSetting("x_accounts", [...new Set(x_accounts)]);
  }
  if (typeof slack_webhook_url === "string" && slack_webhook_url.trim()) writeSecret("SLACK_WEBHOOK_URL", slack_webhook_url.trim());
  if (typeof x_bearer_token === "string" && x_bearer_token.trim()) writeSecret("X_BEARER_TOKEN", x_bearer_token.trim());
  if (typeof claude_api_key === "string" && claude_api_key.trim()) writeSecret("CLAUDE_API_KEY", claude_api_key.trim());
  if (typeof claude_code_oauth_token === "string" && claude_code_oauth_token.trim())
    writeSecret("CLAUDE_CODE_OAUTH_TOKEN", claude_code_oauth_token.trim());

  res.json({
    x_accounts: getSetting("x_accounts", []),
    slack_webhook_set: isSecretSet("SLACK_WEBHOOK_URL"),
    x_token_set: isSecretSet("X_BEARER_TOKEN"),
    claude_api_key_set: isSecretSet("CLAUDE_API_KEY"),
    claude_subscription_set: isSecretSet("CLAUDE_CODE_OAUTH_TOKEN"),
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[server] Dashboard listening on port ${PORT}`);
});
