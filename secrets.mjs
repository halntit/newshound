import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.SECRETS_ENV_PATH || path.join(__dirname, ".env");

/**
 * Read a .env file with one KEY=VALUE per line and return an object.
 * No external library (dotenv) to keep dependencies down - the .env file is simple, just a few lines.
 */
function readEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes; inside double quotes, unescape \" and \\ (mirrors writeSecret)
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Overwrite one key in the .env file (other keys are kept; comments are not). Creates the file if missing.
 * IMPORTANT: .env must be chmod 600 so only the app user can read it - see the README security notes.
 */
export function writeSecret(key, value) {
  if (/[\r\n]/.test(String(value))) throw new Error(`Value for ${key} must not contain line breaks`);

  const current = readEnvFile();
  current[key] = value;

  const lines = Object.entries(current).map(([k, v]) => `${k}="${String(v).replace(/["\\]/g, "\\$&")}"`);
  // Write a temp file then rename: .env survives a crash mid-write, and the new file is always mode 600
  const tmpPath = `${ENV_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmpPath, ENV_PATH);
}

export function getSecret(key) {
  // Real environment variables (e.g. set via systemd EnvironmentFile) take priority, falling back to the .env file
  return process.env[key] || readEnvFile()[key] || null;
}

export function isSecretSet(key) {
  return Boolean(getSecret(key));
}
