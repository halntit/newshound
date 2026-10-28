# News Pipeline — EC2 (Node.js + SQLite)

**Newshound** sniffs out IT, AI and startup news so you don't have to. Every 3 hours it collects articles from RSS feeds, Hacker News and X, drops anything already seen, has Claude merge and summarize them into a short Vietnamese digest, and posts it to Slack. A small dashboard lets you manage sources and secrets without touching the server.

A simplified architecture: no Lambda, no API Gateway, no DynamoDB, no Secrets Manager.
Just one EC2 instance running two components:

- **`server.mjs`** — an always-on process (via systemd) that serves the dashboard and the configuration API
- **`pipeline.mjs`** — a script **run by crontab every 3 hours**; it exits when done (no RAM held while idle)

Both share one SQLite file (`data/news.db`) and one secrets file (`.env`).

## Why the pipeline is a cron script instead of running inside server.mjs

If the schedule lived inside server.mjs (e.g. using `node-cron`), the server would have to keep a timer alive for the full 3 hours between runs — constantly using RAM while doing nothing. With the system crontab, the pipeline process only exists for a few tens of seconds per run and then exits completely, which saves resources as intended.

## Structure

```
server.mjs       # Express - dashboard + API (/api/sources, /api/settings)
pipeline.mjs      # Run by cron - fetch, dedupe, summarize, post to Slack
db.mjs             # SQLite (better-sqlite3) - RSS sources, settings, dedupe
secrets.mjs        # Read/write the .env file (chmod 600) - secrets are NOT stored in SQLite
summarize.mjs       # Prefers Claude subscription (Claude Code CLI), falls back to Claude API
fetchNews.mjs        # RSS + Hacker News + X.com
slack.mjs             # Post to Slack webhook
public/index.html     # Dashboard (single file, no build step)
.env.example           # Secrets file template
```

---

## Step 1 — Prepare EC2

Recommended: **create a dedicated EC2 instance** (t3.micro/t3.small is plenty, the app is very light) instead of sharing the existing reviewbot EC2 — this avoids the blast-radius concern discussed earlier. If you accept the risk and want to share it, run this app under a separate Linux user and don't share credentials with reviewbot.

```bash
# On EC2 (Ubuntu/Amazon Linux)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs build-essential   # build-essential is needed for better-sqlite3 (native module)
node -v   # check >= 20.x
```

## Step 2 — Install the app

```bash
# Extract the source code into a directory, e.g. /opt/news-app
cd /opt/news-app
npm install --production
cp .env.example .env
chmod 600 .env
```

Open `.env` and set `DASHBOARD_API_KEY` to a random string:

```bash
openssl rand -hex 24
# Paste this value into DASHBOARD_API_KEY in .env
```

Leave the remaining values (`SLACK_WEBHOOK_URL`, `X_BEARER_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_API_KEY`) **empty** — you will enter them through the dashboard once the app is running.

## Step 3 — Set up the Claude subscription (preferred)

```bash
npm install -g @anthropic-ai/claude-code
claude setup-token
```

This opens a browser (or prints a link to open on another machine) to sign in to your Claude Pro/Max account, then prints a long OAuth token string. **Copy this token** and paste it into the dashboard once the app is running ("AI summary" section → "Subscription — OAuth token").

> This is the fix for the `claude -p` login problem you hit with reviewbot: use `claude setup-token` to create a token that doesn't need an interactive session, instead of `claude /login` (which requires opening a browser on the EC2 machine itself).

**Important notes:**
- This token shares quota with your everyday interactive Claude Code usage. At 8 runs/day with short prompts it most likely won't matter, but keep an eye on it if you use Claude Code heavily for other work.
- If the subscription fails (quota exhausted, expired token, ...), the pipeline **automatically falls back** to the Claude API — just set `CLAUDE_API_KEY` in the dashboard to have that backup layer.
- Anthropic's policy on using a subscription for headless/automation tasks may change over time — re-check the current terms if you plan to run this long-term in production rather than as a personal project.

## Step 4 — Run the dashboard with systemd (always on)

Create the file `/etc/systemd/system/news-dashboard.service`:

```ini
[Unit]
Description=News Pipeline Dashboard
After=network.target

[Service]
Type=simple
User=<LINUX_USER_NAME>
WorkingDirectory=/home/reviewbot/www/newshound
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now news-dashboard
sudo systemctl status news-dashboard
```

The dashboard now runs at `http://<EC2_PUBLIC_IP>:3000`. Remember to open port 3000 in the Security Group (only for your IP, not publicly), or put an Nginx reverse proxy + HTTPS in front if you want safer access from multiple places.

## Step 5 — Pipeline schedule (crontab)

Posts at **09:00, 12:00, 15:00 and 18:00 GMT+7, Monday to Friday**. EC2 runs cron in **UTC**, so the hours below are GMT+7 minus 7 (all runs stay on the same weekday in UTC).

```bash
crontab -e
```

Add the lines:

```cron
# 12:00, 15:00, 18:00 GMT+7 (05:00, 08:00, 11:00 UTC), Mon–Fri
0 5,8,11 * * 1-5 cd /home/reviewbot/www/newshound && /usr/bin/node pipeline.mjs >> /home/reviewbot/newshound-pipeline.log 2>&1
# 09:00 GMT+7 (02:00 UTC) Tue–Fri: catch up since 18:00 the day before
0 2 * * 2-5 cd /home/reviewbot/www/newshound && LOOKBACK_HOURS=15.5 /usr/bin/node pipeline.mjs >> /home/reviewbot/newshound-pipeline.log 2>&1
# 09:00 GMT+7 (02:00 UTC) Mon: catch up the weekend; longer dedupe window so Friday's items aren't re-posted
0 2 * * 1 cd /home/reviewbot/www/newshound && LOOKBACK_HOURS=63.5 DEDUPE_TTL_HOURS=96 /usr/bin/node pipeline.mjs >> /home/reviewbot/newshound-pipeline.log 2>&1
```

The normal runs look back 3.5 hours (the default `LOOKBACK_HOURS`). The 09:00 runs look back further so news from the evening, night and weekend isn't skipped. Adjust the paths if you cloned somewhere other than `/home/reviewbot/www/newshound`.

Check the log:

```bash
tail -f /home/reviewbot/newshound-pipeline.log
```

## Step 6 — Open the dashboard and configure

Open `http://<EC2_PUBLIC_IP>:3000` and enter the **Dashboard key** (the `DASHBOARD_API_KEY` value from Step 2). Then:

1. **Sources** tab: review the 10 default sources (US/UK/Vietnam news, blogs and Reddit, seeded on first run from `DEFAULT_SOURCES` in `db.mjs`) and add or remove as you like — deleted defaults are not re-added
2. **Settings** tab → **AI summary**: paste the OAuth token from Step 3 (preferred), and/or a Claude API key (fallback)
3. **Settings** tab → **Slack**: paste the Incoming Webhook URL
4. **Settings** tab → **X.com**: paste the Bearer Token and add the accounts to follow

The UI, code and logs are in English; the Slack digest itself is written in Vietnamese (see the prompt in `summarize.mjs`).

## Step 7 — Manual test

```bash
cd /opt/news-app
node pipeline.mjs
```

Watch the output in the terminal — it clearly reports whether the subscription was used or it fell back to the API, and any errors, before you let cron run it automatically.

---

## Security notes

- `.env` holds all 4 sensitive secrets — **`chmod 600` is mandatory** so only the app user can read it. `secrets.mjs` automatically writes the file with this permission every time it saves.
- The dashboard uses a single shared key (`DASHBOARD_API_KEY`) — suitable for a single-user personal tool. If you expand it to multiple users, replace it with a real auth system.
- **Do not** leave port 3000 open to 0.0.0.0/0 in the Security Group — restrict it to your IP, or put it behind a VPN/SSH tunnel.
- The SQLite file (`data/news.db`) is not encrypted — if you need stronger protection, enable EC2 disk encryption (EBS encryption) at the infrastructure level.

## Quick comparison with the previous Lambda architecture

| | Lambda (before) | EC2 (now) |
|---|---|---|
| Idle cost | $0 (pay only when running) | Fixed EC2 cost (small with t3.micro) |
| Pipeline RAM/CPU while idle | None (serverless) | None (pipeline is a cron script, not a resident process) |
| Dashboard RAM/CPU while idle | No separate dashboard (used API Gateway) | ~35-45MB RAM for always-on Express |
| Infrastructure complexity | Many services (Lambda, API Gateway, DynamoDB, Secrets Manager) | 1 EC2, 1 SQLite file, 1 .env file |
| Editing configuration | Via dashboard (unchanged) | Via dashboard (unchanged) |
| AI backend | Claude API only | Subscription preferred, API fallback |
