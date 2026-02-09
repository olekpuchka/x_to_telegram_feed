# X to Telegram Feed

![Workflow Status](https://github.com/olekpuchka/x_to_telegram_feed/workflows/X%20%E2%86%92%20Telegram/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Automatically forwards new posts from an X (Twitter) account to a Telegram channel.

## Features

- 🔄 Automatically polls X for new posts
- 📱 Sends posts to Telegram channel with formatted source links
- 🖼️ Forwards photos and video thumbnails (up to 10 media items per tweet)
- ⚡ Rate-limit safe with graceful error handling
- 🗄️ State persistence via GitHub Gist (no git history pollution)
- 🔁 Runs on GitHub Actions every 30 minutes
- 🎯 Configurable filters (retweets, replies)
- 📝 Support for long-form tweets (note_tweet)
- 🔗 Clean message formatting with automatic t.co link removal
- 🔒 Secret validation prevents misconfiguration
- 📊 Job summaries with run statistics and error details
- 🎛️ Manual trigger with configurable parameters
- 🎯 Post specific tweets by ID

## Setup

### 1. Prerequisites

- X (Twitter) account with API access
- Telegram bot token
- GitHub account (for Actions deployment)

### 2. Get API Tokens

**X Bearer Token:**
1. Go to [Twitter Developer Portal](https://developer.twitter.com/en/portal/dashboard)
2. Create an app (or use existing)
3. Generate Bearer Token

**Telegram Bot Token:**
1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot with `/newbot`
3. Copy the token

**Telegram Chat ID:**
- For public channels: Use `@channelname`
- For private channels: Use the numeric ID (e.g., `-1001234567890`)

### 3. GitHub Gist Setup (for CI/CD)

The workflow uses a private GitHub Gist to store state instead of committing to the repo.

1. Go to [gist.github.com](https://gist.github.com/)
2. Create a **secret gist** with:
   - Filename: `state.json`
   - Content: `{"last_id":null}`
3. Copy the Gist ID from the URL (the long alphanumeric string)

### 4. GitHub Secrets

Add these secrets to your repository at `Settings → Secrets and variables → Actions`:

| Secret | Description |
|--------|-------------|
| `X_BEARER_TOKEN` | Your X API Bearer Token |
| `X_USERNAME` | X handle to monitor (without @) |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram channel ID |
| `STATE_GIST_ID` | The Gist ID from step 3 |
| `GIST_TOKEN` | Personal Access Token with `gist` scope |

**To create `GIST_TOKEN`:**
1. Go to [GitHub Settings → Tokens](https://github.com/settings/tokens/new)
2. Note: `X to Telegram Gist Access`
3. Expiration: No expiration (or 1 year)
4. Scopes: Check **`gist`** only
5. Generate and copy the token

> **Note:** The workflow automatically validates that all required secrets are configured before running. If any secret is missing, the workflow will fail with a clear error message indicating which secret needs to be added.

## Usage

### Automatic Runs

The workflow runs automatically every 30 minutes with default settings:
- Processes up to 50 tweets per run
- Posts to your configured Telegram channel

### Manual Runs

You can trigger the workflow manually with custom parameters:

1. Go to **Actions** tab in your repository
2. Select **X → Telegram** workflow
3. Click **Run workflow** dropdown
4. Configure parameters:
   - **Maximum tweets to process per run**: Enter a number (default: `50`)
   - **Run in dry-run mode**: Check to test without posting (default: unchecked)
   - **Specific tweet ID to post**: Enter a tweet ID to post a specific tweet (overrides timeline fetching)
5. Click **Run workflow** to execute

**Posting a specific tweet:**
- Extract the tweet ID from the URL: `https://x.com/username/status/1234567890` → ID is `1234567890`
- Enter this ID in the "Specific tweet ID to post" field
- When a tweet ID is provided, the workflow will fetch and post only that specific tweet
- This is useful for manually posting older tweets or specific content

### Job Summaries

After each run, a summary is automatically created showing:
- ✅ Job status (success/failure)
- 📊 Number of tweets posted
- 👤 Username being monitored
- 🎯 Run mode (timeline fetch or specific tweet ID)
- 🧪 Dry run status (if applicable)
- ⏰ Execution timestamp
- ⚠️ Error details (on failure)

View summaries in the Actions tab under each workflow run.

## Configuration

### Command Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `--username` | `X_USERNAME` env | X handle (without @) |
| `--include-retweets` | `false` | Also forward retweets |
| `--include-replies` | `false` | Also forward replies |
| `--max-per-run` | `50` | Max tweets to post per run |
| `--disable-preview` | `false` | Disable link previews |
| `--dry-run` | `false` | Test mode (no actual posting) |
| `--tweet-id` | - | Specific tweet ID to post (overrides timeline) |

### Examples

```bash
# Monitor specific user
X_USERNAME=username node x_to_telegram.js

# Include retweets and replies
node x_to_telegram.js --include-retweets --include-replies

# Dry run to test
node x_to_telegram.js --dry-run

# Post a specific tweet by ID
node x_to_telegram.js --tweet-id 1234567890

# Post a specific tweet in dry-run mode
node x_to_telegram.js --tweet-id 1234567890 --dry-run
```

## How It Works

1. **Fetch**: Queries X API for new posts since last known tweet ID
2. **Filter**: Excludes retweets/replies (unless enabled)
3. **Format**: Formats tweets with text, removes t.co URLs, and extracts media
4. **Post**: Forwards each tweet to Telegram (with photos if available)
5. **Update**: Saves latest tweet ID and cached user ID to GitHub Gist
6. **Repeat**: Runs every 30 minutes via GitHub Actions

### Message Format

Tweets are posted to Telegram in the following format:

**Text-only tweets:**
```
[Tweet text with t.co URLs removed]

Source:
https://x.com/username/status/123456789
```

**Tweets with photos:**
- Single photo: Sent as photo with caption
- Multiple photos: Sent as media group (up to 10) with caption
- Caption includes tweet text (trimmed to 1024 chars if needed)
- Full text sent separately if caption exceeds limit

**Tweets with videos:**
- Video thumbnails are sent as photo previews (free Twitter API tier limitation - only `preview_image_url` available, not full video URLs)
- Messages include a 🎬 indicator with a note to click the source link
- Mixed media: Sent as media group with photos and video thumbnails
- Same caption handling as photos
- Click the source link to watch the full video

## Troubleshooting

### Workflow Setup Issues

**Missing Secrets Error:**
- The workflow validates all required secrets before execution
- If you see "Error: [SECRET_NAME] secret is not set":
  1. Go to repository **Settings → Secrets and variables → Actions**
  2. Add the missing secret(s) listed in the error message
  3. Re-run the workflow

**Check Job Summaries:**
- Every workflow run creates a summary in the Actions tab
- Summaries show status, tweets posted, and error details
- Failed runs include the last 20 log lines for debugging

### Rate Limits

The script handles X API rate limits gracefully with improved error detection:
- Catches rate limit errors from multiple API response formats
- Returns early on 429 errors
- Logs warning and continues on next run
- GitHub Actions timeout: 5 minutes

### No New Tweets

If you see `[info] No new tweets`, it means:
- No new posts since last check, or
- User hasn't posted since the saved `last_id`

### Telegram Errors

Long tweets are automatically chunked at Telegram's 4096 character limit. If posting fails:
- Check bot has admin rights in the channel
- Verify `TELEGRAM_CHAT_ID` format
- For private channels, ensure bot was added as admin

**Photo posting issues:**
- Photos and videos are sent with captions (max 1024 chars)
- If media delivery fails, tweet is sent as text-only (fallback)
- Media groups support up to 10 items (photos and videos) per tweet
- Both photos and videos are fully supported

## Development

### Project Structure

```
.
├── x_to_telegram.js          # Main script
├── .github/
│   └── workflows/
│       └── x-to-telegram.yml # GitHub Actions workflow
├── .gitignore
├── package.json
├── package-lock.json
├── LICENSE
└── README.md
```

### Local Testing

```bash
# Test with dry-run
node x_to_telegram.js --username nasa --dry-run

# Test with limited output
node x_to_telegram.js --username nasa --max-per-run 1
```

## License

MIT

## Contributing

Issues and PRs welcome!
