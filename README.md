# X to Telegram Feed

![Workflow Status](https://github.com/olekpuchka/x_to_telegram_feed/workflows/X%20%E2%86%92%20Telegram/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Automatically forwards new posts from an X (Twitter) account to a Telegram channel.

## Features

- 🔄 Automatically polls X for new posts
- 📱 Sends posts to Telegram channel with formatting preserved
- ⚡ Rate-limit safe with graceful error handling
- 🗄️ State persistence via GitHub Gist (no git history pollution)
- 🔁 Runs on GitHub Actions every 30 minutes
- 🎯 Configurable filters (retweets, replies)
- 📝 Support for long-form tweets (note_tweet)

## Setup

### 1. Prerequisites

- Node.js 20+
- X (Twitter) account with API access
- Telegram bot token
- GitHub account (for Actions deployment)

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Variables

Create a `.env` file for local development:

```env
X_BEARER_TOKEN=your_twitter_bearer_token_here
TELEGRAM_BOT_TOKEN=1234567890:ABCDEF...
TELEGRAM_CHAT_ID=@your_channel
```

**Get X Bearer Token:**
1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Create an app (or use existing)
3. Generate Bearer Token

**Get Telegram Bot Token:**
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot with `/newbot`
3. Copy the token

**Get Telegram Chat ID:**
- For public channels: Use `@channelname`
- For private channels: Use the numeric ID (e.g., `-1001234567890`)

### 4. GitHub Gist Setup (for CI/CD)

The workflow uses a private GitHub Gist to store state instead of committing to the repo.

1. Go to [gist.github.com](https://gist.github.com/)
2. Create a **secret gist** with:
   - Filename: `state.json`
   - Content: `{"last_id":null}`
3. Copy the Gist ID from the URL (the long alphanumeric string)

### 5. GitHub Secrets

Add these secrets to your repository at `Settings → Secrets and variables → Actions`:

| Secret | Description |
|--------|-------------|
| `X_BEARER_TOKEN` | Your X API Bearer Token |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram channel ID |
| `STATE_GIST_ID` | The Gist ID from step 4 |
| `GIST_TOKEN` | Personal Access Token with `gist` scope |

**To create `GIST_TOKEN`:**
1. Go to [GitHub Settings → Tokens](https://github.com/settings/tokens/new)
2. Note: `X to Telegram Gist Access`
3. Expiration: No expiration (or 1 year)
4. Scopes: Check **`gist`** only
5. Generate and copy the token

## Usage

### Run Locally (One-Time)

```bash
node x_to_telegram.js --once
```

### Run Locally (Continuous Polling)

```bash
node x_to_telegram.js --interval 900
```

### Run in GitHub Actions

The workflow runs automatically every 30 minutes. You can also trigger it manually:

1. Go to **Actions** tab
2. Select **X → Telegram** workflow
3. Click **Run workflow**

## Configuration

### Command Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `--username` | `joecarlsonshow` | X handle (without @) |
| `--state-file` | `last_tweet_id.json` | Local state file path |
| `--interval` | `900` | Polling interval in seconds |
| `--once` | `false` | Run once and exit |
| `--include-retweets` | `false` | Also forward retweets |
| `--include-replies` | `false` | Also forward replies |
| `--max-per-run` | `50` | Max tweets to post per run |
| `--disable-preview` | `false` | Disable link previews |
| `--dry-run` | `false` | Test mode (no actual posting) |

### Examples

```bash
# Monitor different user
node x_to_telegram.js --username elonmusk --once

# Include retweets and replies
node x_to_telegram.js --include-retweets --include-replies

# Dry run to test
node x_to_telegram.js --dry-run --once
```

## How It Works

1. **Fetch**: Queries X API for new posts since last known tweet ID
2. **Filter**: Excludes retweets/replies (unless enabled)
3. **Post**: Forwards each tweet to Telegram with formatting
4. **Update**: Saves latest tweet ID to Gist (CI) or local file (dev)
5. **Repeat**: On GitHub Actions, runs every 30 minutes

## State Management

- **GitHub Actions**: State stored in private GitHub Gist (no repo commits)
- **Local Development**: Falls back to `last_tweet_id.json` file

## Troubleshooting

### Rate Limits

The script handles X API rate limits gracefully:
- Returns early on 429 errors
- Logs warning and continues on next run
- GitHub Actions timeout: 5 minutes

### No New Tweets

If you see `[info] No new tweets`, it means:
- No new posts since last check, or
- User hasn't posted since the saved `last_id`

### Telegram Errors

Long tweets are automatically chunked (4096 char limit). If posting fails:
- Check bot has admin rights in the channel
- Verify `TELEGRAM_CHAT_ID` format
- For private channels, ensure bot was added as admin

## Development

### Project Structure

```
.
├── x_to_telegram.js          # Main script
├── .github/
│   └── workflows/
│       └── x-to-telegram.yml # GitHub Actions workflow
├── src/                      # Source modules (if any)
└── package.json
```

### Local Testing

```bash
# Test with dry-run
node x_to_telegram.js --dry-run --once

# Test specific user
node x_to_telegram.js --username nasa --once --max-per-run 1
```

## License

MIT

## Contributing

Issues and PRs welcome!
