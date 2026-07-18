# Project Guidelines

## Overview

Single-file Node.js bot that polls an X (Twitter) account for new posts and forwards them to a Telegram channel. Runs hourly via GitHub Actions. State is persisted in a GitHub Gist (`x-telegram-sync.json`).

## Tech Stack

- **Runtime**: Node.js >= 24, ESM modules (`"type": "module"`)
- **Dependencies**: `twitter-api-v2` (X API v2), `grammy` (Telegram Bot), `yargs` (CLI)
- **No test framework** — test manually against a scratch Telegram channel

## Build and Test

```bash
npm ci                # Install dependencies
npm start             # Run the bot (requires env vars)
node x_to_telegram.js --max-per-run 1  # Smallest test run (posts for real)
```

## Architecture

Everything lives in [`x_to_telegram.js`](x_to_telegram.js) — single-file architecture with clearly sectioned blocks:

1. **Constants** — Telegram/X API limits
2. **Utilities** — Logging, Gist state CRUD, message chunking, text/media extraction
3. **Telegram sending** — `sendToTelegram` orchestrator with media fallback to text-only
4. **X API helpers** — Client setup, tweet fetching
5. **Core run** — User ID caching, tweet processing loop, error handling
6. **CLI/main** — `yargs` options, entry-point guard via `import.meta.url`

## Code Conventions

- **Native `fetch()`** for HTTP (no axios/node-fetch) — Node 24+ built-in
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

## Error Handling & Rate Limiting

- X API free tier has strict per-endpoint limits (~1-5 req/15min)
- Recoverable X API errors are caught in `run()` and treated as **non-fatal** (log warning, skip run):
  - **429** Too Many Requests (rate limit)
  - **402** Payment Required (endpoint not in current API plan)
  - **5xx** Transient server errors / X API outages
- Any other error is re-thrown and exits non-zero (fails the workflow run)
- The next scheduled run resumes from the same `last_id`, so a skipped run loses nothing
- No rate limit logging on success (headers show app-level buckets, not endpoint limits)
- Workflow runs hourly with `cancel-in-progress: true` concurrency

## CI/CD

Workflow: [`.github/workflows/x-to-telegram.yml`](.github/workflows/x-to-telegram.yml)

- **Schedule**: Hourly cron + manual `workflow_dispatch`
- **Job summary**: One-line status with tweet count (e.g., "✅ 3 tweets posted")
- **Timeout**: 5 minutes — script exits fast on rate limits
- **Secrets validation**: All 6 env vars are checked before the script runs
