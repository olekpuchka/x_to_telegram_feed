#!/usr/bin/env node

/**
 * Post new X (Twitter) posts from a user to a Telegram channel.
 *
 * Requirements:
 *   npm install twitter-api-v2 grammy dotenv yargs
 *
 * Env (.env or environment):
 *   X_BEARER_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TELEGRAM_BOT_TOKEN=1234567890:ABCDEF...
 *   TELEGRAM_CHAT_ID=@your_channel   # or -1001234567890
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { TwitterApi } from 'twitter-api-v2';
import { Bot } from 'grammy';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

// -------------------------
// Defaults
// -------------------------
const DEFAULT_USERNAME = "joecarlsonshow";
const DEFAULT_STATE_FILE = "last_tweet_id.json";
const DEFAULT_INTERVAL = 900; // seconds
const DEFAULT_MAX_PER_RUN = 50;

// -------------------------
// Utilities
// -------------------------
function log(msg) {
    console.log(msg);
}

function err(msg) {
    console.error(msg);
}

async function loadState(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        // If file doesn't exist or is invalid, return default
        return { last_id: null };
    }
}

async function saveState(filePath, lastId) {
    try {
        await fs.writeFile(filePath, JSON.stringify({ last_id: lastId }), 'utf-8');
    } catch (e) {
        err(`[state] Could not write ${filePath}: ${e.message}`);
    }
}

function chunkTelegramMessage(text, chunkSize = 4096) {
    if (text.length <= chunkSize) {
        return [text];
    }
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);
        // Try to cut at the last newline
        let cut = text.lastIndexOf('\n', end);
        if (cut === -1 || cut <= start) {
            cut = end;
        }
        chunks.push(text.substring(start, cut));
        start = cut;
    }
    return chunks;
}

function extractTweetText(tweet) {
    // Check for note_tweet (long form)
    if (tweet.note_tweet && tweet.note_tweet.text) {
        return tweet.note_tweet.text.trim();
    }
    return (tweet.text || "").trim();
}

function buildMessage(username, tweet) {
    // tweet.created_at is ISO string from API
    const tweetUrl = `https://x.com/${username}/status/${tweet.id}`;
    const text = extractTweetText(tweet);

    return `${text}\n\n${tweetUrl}`;
}

async function sendToTelegram(bot, chatId, message, disablePreview = false, dryRun = false) {
    if (dryRun) {
        log(`[dry-run] Telegram message:\n${message}\n${'-'.repeat(40)}`);
        return;
    }

    const chunks = chunkTelegramMessage(message);

    for (const part of chunks) {
        try {
            await bot.api.sendMessage(chatId, part, {
                disable_web_page_preview: disablePreview,
                parse_mode: 'HTML'
            });
        } catch (e) {
            err(`[telegram] ${e.message}`);
            throw e;
        }
    }
}

// -------------------------
// X (Twitter) client helpers
// -------------------------
function getClient() {
    const bearer = process.env.X_BEARER_TOKEN;
    if (!bearer) {
        throw new Error("Missing X_BEARER_TOKEN. Set it in your environment or .env file.");
    }
    return new TwitterApi(bearer);
}

async function getUserId(client, username) {
    const user = await client.v2.userByUsername(username);
    if (!user.data) {
        throw new Error(`User @${username} not found.`);
    }
    return user.data.id;
}

async function fetchNewTweets(client, userId, sinceId, includeRetweets, includeReplies, maxPerRun) {
    const exclude = [];
    if (!includeRetweets) exclude.push('retweets');
    if (!includeReplies) exclude.push('replies');

    // twitter-api-v2 pagination helper
    // We only need one page as per original logic
    const tweets = await client.v2.userTimeline(userId, {
        since_id: sinceId || undefined,
        max_results: Math.min(100, maxPerRun),
        "tweet.fields": ["created_at", "entities", "note_tweet"],
        exclude: exclude.length ? exclude : undefined
    });

    // The library returns a paginator, .data.data contains the tweets
    // If no tweets, .data.data might be undefined
    const data = tweets.data.data || [];

    // Sort oldest -> newest (API returns newest first)
    data.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);

    return data.slice(0, maxPerRun);
}

// -------------------------
// Core run step
// -------------------------
async function runOnce(args, bot = null) {
    const { username, stateFile, includeRetweets, includeReplies, maxPerRun, disablePreview, dryRun } = args;
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;

    if (!tgToken || !tgChat) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
    }

    // Create bot instance once and reuse
    if (!bot && !dryRun) {
        bot = new Bot(tgToken);
    }

    const client = getClient();
    const userId = await getUserId(client, username);

    const state = await loadState(stateFile);
    let lastId = state.last_id;

    try {
        const tweets = await fetchNewTweets(client, userId, lastId, includeRetweets, includeReplies, maxPerRun);

        if (tweets.length === 0) {
            log("[info] No new tweets.");
            return lastId;
        }

        for (const t of tweets) {
            const msg = buildMessage(username, t);
            await sendToTelegram(bot, tgChat, msg, disablePreview, dryRun);
            lastId = t.id;
            await saveState(stateFile, lastId);
            log(`[posted] ${t.id}`);
        }
    } catch (e) {
        if (e.code === 429) {
            log("[warning] X API rate limit reached — skipping this run.");
            return lastId;
        }
        throw e;
    }

    return lastId;
}

// -------------------------
// Main / CLI
// -------------------------
async function main() {
    const argv = yargs(hideBin(process.argv))
        .option('username', { default: DEFAULT_USERNAME, describe: 'X handle without @' })
        .option('state-file', { default: DEFAULT_STATE_FILE, describe: 'Path to last_id state file' })
        .option('interval', { default: DEFAULT_INTERVAL, type: 'number', describe: 'Loop interval seconds' })
        .option('once', { type: 'boolean', describe: 'Run a single cycle and exit' })
        .option('include-retweets', { type: 'boolean', describe: 'Also post retweets' })
        .option('include-replies', { type: 'boolean', describe: 'Also post replies' })
        .option('max-per-run', { default: DEFAULT_MAX_PER_RUN, type: 'number', describe: 'Max tweets to post per run' })
        .option('disable-preview', { type: 'boolean', describe: 'Disable Telegram link previews' })
        .option('dry-run', { type: 'boolean', describe: 'Do everything except sending to Telegram' })
        .help()
        .argv;

    if (argv.once) {
        try {
            await runOnce(argv);
        } catch (e) {
            err(`[error] ${e.message}`);
            process.exit(1);
        }
        return;
    }

    log(`[start] Polling @${argv.username} every ${argv.interval}s. Press Ctrl+C to stop.`);

    // Create bot instance once for the entire loop
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const bot = argv.dryRun ? null : (tgToken ? new Bot(tgToken) : null);

    // Initial run
    // We wrap in a loop
    while (true) {
        try {
            await runOnce(argv, bot);
        } catch (e) {
            if (e.code === 429) {
                 log("[warning] Rate limited in loop — sleeping 300s then continuing.");
                 await new Promise(resolve => setTimeout(resolve, 300000));
            } else {
                err(`[error] ${e.message}`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(5000, argv.interval * 1000)));
    }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    main();
}
