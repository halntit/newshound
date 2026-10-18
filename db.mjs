import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "news.db");

// Make sure the directory holding the DB file exists
import fs from "node:fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // safer when 2 processes (server.mjs + pipeline.mjs) read/write concurrently

db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS seen_links (
    link_hash TEXT PRIMARY KEY,
    link TEXT NOT NULL,
    title TEXT,
    seen_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_seen_links_seen_at ON seen_links(seen_at);
`);

// ---------- Sources ----------

export function listSources() {
  return db.prepare("SELECT id, name, url, category FROM sources ORDER BY created_at, rowid").all();
}

export function addSource({ name, url, category }) {
  const id = randomUUID();
  db.prepare("INSERT INTO sources (id, name, url, category, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    url,
    category,
    new Date().toISOString()
  );
  return { id, name, url, category };
}

export function deleteSource(id) {
  db.prepare("DELETE FROM sources WHERE id = ?").run(id);
}

// Starter mix of US / UK / Vietnam news, blogs and public social posts (Hacker News is built into fetchNews.mjs)
const DEFAULT_SOURCES = [
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", category: "Startup" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", category: "International" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", category: "AI" },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", category: "AI" },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", category: "Europe" },
  { name: "The Register", url: "https://www.theregister.com/headlines.atom", category: "Europe" },
  { name: "VnExpress Khoa hoc Cong nghe", url: "https://vnexpress.net/rss/khoa-hoc-cong-nghe.rss", category: "Vietnam" },
  { name: "Tuoi Tre Nhip song so", url: "https://tuoitre.vn/rss/nhip-song-so.rss", category: "Vietnam" },
  { name: "Genk", url: "https://genk.vn/rss/home.rss", category: "Vietnam" },
  // Reddit often rate-limits (HTTP 429) unauthenticated/cloud requests; the pipeline just logs and skips it then
  { name: "Reddit r/technology", url: "https://www.reddit.com/r/technology/top/.rss?t=day", category: "International" },
];

/**
 * Insert DEFAULT_SOURCES once, on a database that has never been seeded and has no sources.
 * The "sources_seeded" flag means deleted defaults never come back. IMMEDIATE transaction because
 * server.mjs and pipeline.mjs may both open a fresh database at the same time.
 */
function seedDefaultSources() {
  db.transaction(() => {
    if (getSetting("sources_seeded", false)) return;
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM sources").get();
    if (count === 0) DEFAULT_SOURCES.forEach(addSource);
    setSetting("sources_seeded", true);
  }).immediate();
}

// ---------- Settings (simple key-value, e.g. x_accounts) ----------
// NOTE: real secrets (Slack webhook, X token, Claude API key) are NOT stored here - see secrets.mjs, which reads the .env file

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, serialized);
}

// ---------- Dedupe (replaces DynamoDB TTL with periodic cleanup) ----------

export function filterUnseen(items, linkHashFn) {
  const stmt = db.prepare("SELECT 1 FROM seen_links WHERE link_hash = ?");
  return items.filter((item) => !stmt.get(linkHashFn(item.link)));
}

export function markSeen(items, linkHashFn) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO seen_links (link_hash, link, title, seen_at) VALUES (?, ?, ?, ?)"
  );
  const now = Date.now();
  const insertMany = db.transaction((rows) => {
    for (const item of rows) insert.run(linkHashFn(item.link), item.link, item.title, now);
  });
  insertMany(items);
}

/**
 * Delete records older than N hours - replaces DynamoDB's TTL.
 * Call this periodically (e.g. on every pipeline run) so the table doesn't grow forever.
 */
export function cleanupOldSeenLinks(hoursToKeep = 48) {
  const cutoff = Date.now() - hoursToKeep * 3600 * 1000;
  const res = db.prepare("DELETE FROM seen_links WHERE seen_at < ?").run(cutoff);
  return res.changes;
}

seedDefaultSources();

export default db;
