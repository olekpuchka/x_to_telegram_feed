#!/usr/bin/env python3
"""
Post new X (Twitter) posts from a user to a Telegram channel.

Requirements:
  pip install tweepy python-dotenv requests

Env (.env or environment):
  X_BEARER_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
  TELEGRAM_BOT_TOKEN=1234567890:ABCDEF...
  TELEGRAM_CHAT_ID=@your_channel   # or -1001234567890

Typical GitHub Actions step:
  python x_to_telegram.py --once --max-per-run 50
"""

import argparse
import json
import os
import sys
import time
from datetime import timezone
from typing import List, Optional

import requests
import tweepy
from tweepy.errors import TooManyRequests
from dotenv import load_dotenv

# -------------------------
# Defaults (override via CLI)
# -------------------------
DEFAULT_USERNAME = "joecarlsonshow"
DEFAULT_STATE_FILE = "last_tweet_id.json"
DEFAULT_INTERVAL = 900          # seconds (15 min) when looping locally
DEFAULT_MAX_PER_RUN = 50        # safety cap (we request a single page anyway)

# -------------------------
# Utilities
# -------------------------
def log(msg: str):
    print(msg, flush=True)

def err(msg: str):
    print(msg, file=sys.stderr, flush=True)

def load_state(path: str) -> dict:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            err(f"[state] Could not read {path}: {e}")
    return {"last_id": None}

def save_state(path: str, last_id: Optional[str]):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"last_id": last_id}, f)
    except Exception as e:
        err(f"[state] Could not write {path}: {e}")

def chunk_telegram_message(text: str, chunk_size: int = 4096) -> List[str]:
    """Split long text into Telegram-safe chunks (max 4096 chars)."""
    if len(text) <= chunk_size:
        return [text]
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        cut = text.rfind("\n", start, end)
        if cut == -1 or cut <= start:
            cut = end
        chunks.append(text[start:cut])
        start = cut
    return chunks

def extract_tweet_text(tweet: tweepy.Tweet) -> str:
    """Return the full tweet text, including Blue long-form tweets."""
    note_tweet = getattr(tweet, "note_tweet", None)
    if isinstance(note_tweet, dict):
        text = note_tweet.get("text")
        if text:
            return text.strip()

    # Tweepy 4.14+ exposes raw data mapping on tweet.data
    data = getattr(tweet, "data", None)
    if isinstance(data, dict):
        note = data.get("note_tweet")
        if isinstance(note, dict):
            text = note.get("text")
            if text:
                return text.strip()

    return (getattr(tweet, "text", "") or "").strip()


def build_message(username: str, tweet: tweepy.Tweet) -> str:
    created_utc = tweet.created_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if tweet.created_at else "unknown time"
    tweet_url = f"https://x.com/{username}/status/{tweet.id}"
    text = extract_tweet_text(tweet)
    # Only include the tweet text and a single link to the tweet itself.
    # Previously we appended expanded URLs (e.g. pic.twitter.com links) which
    # resulted in multiple links being posted for tweets with photos/videos.
    lines = [
        text,
        "",
        tweet_url,
    ]

    return "\n".join(lines).strip()

def send_to_telegram(bot_token: str, chat_id: str, message: str, disable_preview: bool = False, dry_run: bool = False):
    if dry_run:
        log(f"[dry-run] Telegram message:\n{message}\n{'-'*40}")
        return

    api = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    for part in chunk_telegram_message(message, 4096):
        payload = {
            "chat_id": chat_id,
            "text": part,
            "disable_web_page_preview": disable_preview,
            "parse_mode": "HTML",  # safe default; we don't rely on formatting
        }
        r = requests.post(api, json=payload, timeout=20)
        if r.status_code != 200:
            err(f"[telegram] HTTP {r.status_code} {r.text}")
            r.raise_for_status()

# -------------------------
# X (Twitter) client helpers
# -------------------------
def x_client_from_env() -> tweepy.Client:
    bearer = os.getenv("X_BEARER_TOKEN")
    if not bearer:
        raise SystemExit("Missing X_BEARER_TOKEN. Set it in your environment or .env file.")
    # IMPORTANT: don't auto-sleep; fail fast on rate limit
    return tweepy.Client(bearer_token=bearer, wait_on_rate_limit=False)

def get_user_id(client: tweepy.Client, username: str) -> str:
    resp = client.get_user(username=username)
    if not resp or not resp.data:
        raise SystemExit(f"User @{username} not found.")
    return str(resp.data.id)

def fetch_new_tweets(
    client: tweepy.Client,
    user_id: str,
    since_id: Optional[str],
    include_retweets: bool,
    include_replies: bool,
    max_per_run: int,
):
    """
    Fetch a single page from the user's timeline (newest first).
    We sort ascending so we can post oldest -> newest.
    Only ONE API call per run to avoid hitting quotas.
    """
    exclude = []
    if not include_retweets:
        exclude.append("retweets")
    if not include_replies:
        exclude.append("replies")

    resp = client.get_users_tweets(
        id=user_id,
        since_id=since_id,
        max_results=min(100, max_per_run),
    tweet_fields=["created_at", "entities", "note_tweet"],
        exclude=exclude or None,
    )

    tweets = list(resp.data or [])
    tweets.sort(key=lambda t: int(t.id))  # oldest -> newest
    return tweets[:max_per_run]

# -------------------------
# Core run step
# -------------------------
def run_once(
    username: str,
    state_file: str,
    telegram_token: str,
    telegram_chat_id: str,
    include_retweets: bool,
    include_replies: bool,
    max_per_run: int,
    disable_preview: bool,
    dry_run: bool,
) -> Optional[str]:
    client = x_client_from_env()
    user_id = get_user_id(client, username)

    state = load_state(state_file)
    last_id = state.get("last_id")

    try:
        tweets = fetch_new_tweets(
            client=client,
            user_id=user_id,
            since_id=last_id,
            include_retweets=include_retweets,
            include_replies=include_replies,
            max_per_run=max_per_run,
        )
    except TooManyRequests:
        # Fail fast so CI runners don't sit idle for ~10 minutes
        log("[warning] X API rate limit reached — skipping this run.")
        return last_id

    if not tweets:
        log("[info] No new tweets.")
        return last_id

    for t in tweets:
        msg = build_message(username, t)
        send_to_telegram(telegram_token, telegram_chat_id, msg, disable_preview, dry_run)
        last_id = str(t.id)
        save_state(state_file, last_id)
        log(f"[posted] {t.id}")

    return last_id

# -------------------------
# Main / CLI
# -------------------------
def main():
    load_dotenv()

    parser = argparse.ArgumentParser(description="Post new X posts to Telegram channel.")
    parser.add_argument("--username", default=DEFAULT_USERNAME, help="X handle without @")
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE, help="Path to last_id state file (json)")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="Loop interval seconds (ignored with --once)")
    parser.add_argument("--once", action="store_true", help="Run a single cycle and exit")
    parser.add_argument("--include-retweets", action="store_true", help="Also post retweets")
    parser.add_argument("--include-replies", action="store_true", help="Also post replies")
    parser.add_argument("--max-per-run", type=int, default=DEFAULT_MAX_PER_RUN, help="Max tweets to post per run (safety cap)")
    parser.add_argument("--disable-preview", action="store_true", help="Disable Telegram link previews")
    parser.add_argument("--dry-run", action="store_true", help="Do everything except sending to Telegram")

    args = parser.parse_args()

    tg_token = os.getenv("TELEGRAM_BOT_TOKEN")
    tg_chat = os.getenv("TELEGRAM_CHAT_ID")

    if not tg_token or not tg_chat:
        raise SystemExit("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Set them in your environment or .env file.")

    if args.once:
        try:
            run_once(
                username=args.username,
                state_file=args.state_file,
                telegram_token=tg_token,
                telegram_chat_id=tg_chat,
                include_retweets=args.include_retweets,
                include_replies=args.include_replies,
                max_per_run=max(1, args.max_per_run),
                disable_preview=args.disable_preview,
                dry_run=args.dry_run,
            )
        except TooManyRequests:
            log("[warning] Rate limited at top-level — exiting early.")
            sys.exit(0)
        return

    # Looping (useful if you run it on your own machine; for Actions use --once)
    log(f"[start] Polling @{args.username} every {args.interval}s. Press Ctrl+C to stop.")
    while True:
        try:
            run_once(
                username=args.username,
                state_file=args.state_file,
                telegram_token=tg_token,
                telegram_chat_id=tg_chat,
                include_retweets=args.include_retweets,
                include_replies=args.include_replies,
                max_per_run=max(1, args.max_per_run),
                disable_preview=args.disable_preview,
                dry_run=args.dry_run,
            )
        except TooManyRequests:
            log("[warning] Rate limited in loop — sleeping 300s then continuing.")
            time.sleep(300)
        except KeyboardInterrupt:
            log("\n[stop] Exiting by user request.")
            break
        except Exception as e:
            err(f"[error] {e}")
        time.sleep(max(5, args.interval))

if __name__ == "__main__":
    main()
