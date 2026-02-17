# Project Guidelines

## Overview

Single-file Node.js bot that polls an X (Twitter) account for new posts and forwards them to a Telegram channel. Runs hourly via GitHub Actions. State is persisted in a GitHub Gist (`state.json`).

## Tech Stack

- **Runtime**: Node.js >= 20, ESM modules (`"type": "module"`)
- **Dependencies**: `twitter-api-v2` (X API v2), `grammy` (Telegram Bot), `yargs` (CLI)
- **No test framework** — use `--dry-run` mode for manual testing

## Build and Test

```bash
npm ci                # Install dependencies
npm start             # Run the bot (requires env vars)
node x_to_telegram.js --dry-run --max-per-run 1  # Test without posting
```

## Architecture

Everything lives in [`x_to_telegram.js`](../x_to_telegram.js) — single-file architecture with clearly sectioned blocks:

1. **Constants** — Telegram/X API limits
2. **Utilities** — Logging, Gist state CRUD, message chunking, text/media extraction
3. **Telegram sending** — `sendToTelegram` orchestrator with media fallback to text-only
4. **X API helpers** — Client setup, rate limit logging, tweet fetching
5. **Core run** — User ID caching, tweet processing loop, 429 handling
6. **CLI/main** — `yargs` options, entry-point guard via `import.meta.url`

## Code Conventions

- **Native `fetch()`** for HTTP (no axios/node-fetch) — Node 20 built-in
- **Timestamped logging**: Always use `log()` / `logError()`, never raw `console.log`
- **State is crash-safe**: `saveState()` is called after each individual tweet is posted, not in batch
- **User ID caching**: Stored in Gist state to avoid burning rate-limited API calls
- **Tweet sorting**: Oldest → newest by ID (lexicographic) to maintain chronological order
- **Media fallback**: If media send fails, fall back to text-only (never lose a post)
- **`t.co` URL stripping**: Tweet text has shortened URLs removed since source link is appended separately

## Environment Variables

All required — set via GitHub Secrets:

| Variable | Purpose |
|----------|---------|
| `X_BEARER_TOKEN` | X API v2 Bearer Token |
| `X_USERNAME` | X handle to monitor (without @) |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | Target Telegram channel/chat |
| `STATE_GIST_ID` | GitHub Gist ID for state persistence |
| `GIST_TOKEN` | GitHub PAT with `gist` scope |

## Rate Limiting

- X API free tier has strict per-endpoint limits (~1 req/15min for user timeline)
- 429 errors are caught and treated as **non-fatal** (log warning, return early)
- The `rateLimit` headers in errors may reflect app-level buckets, not endpoint-level — trust the 429 status code
- Workflow runs hourly with `cancel-in-progress: true` concurrency

## CI/CD

Workflow: [`.github/workflows/x-to-telegram.yml`](workflows/x-to-telegram.yml)

- **Schedule**: Hourly cron + manual `workflow_dispatch`
- **Job summary**: Shows status (success/rate-limited/failed), tweet count, timestamp (Amsterdam TZ)
- **Timeout**: 5 minutes — script exits fast on rate limits
- **Secrets validation**: All 6 env vars are checked before the script runs
