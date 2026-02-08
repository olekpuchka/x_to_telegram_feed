#!/usr/bin/env node

/**
 * Post new X (Twitter) posts from a user to a Telegram channel.
 *
 * Requirements:
 *   npm install twitter-api-v2 grammy yargs
 *
 * Environment variables (set via GitHub Secrets):
 *   X_BEARER_TOKEN, X_USERNAME, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   STATE_GIST_ID, GIST_TOKEN
 */

import { TwitterApi } from 'twitter-api-v2';
import { Bot } from 'grammy';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

// -------------------------
// Defaults
// -------------------------
const DEFAULT_MAX_PER_RUN = 50;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const X_API_MAX_RESULTS = 100;
const GIST_STATE_FILE = 'state.json';

// -------------------------
// Utilities
// -------------------------
function getTimestamp() {
    return new Date().toISOString();
}

function log(msg) {
    console.log(`${getTimestamp()} ${msg}`);
}

function logError(msg) {
    console.error(`${getTimestamp()} ${msg}`);
}

function getGistCredentials() {
    const gistId = process.env.STATE_GIST_ID;
    const gistToken = process.env.GIST_TOKEN;
    if (!gistId || !gistToken) {
        throw new Error("Missing STATE_GIST_ID or GIST_TOKEN.");
    }
    return { gistId, gistToken };
}

function getGistUrl(gistId) {
    return `https://api.github.com/gists/${gistId}`;
}

function getGistHeaders(gistToken) {
    return {
        'Authorization': `Bearer ${gistToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

async function loadState() {
    const { gistId, gistToken } = getGistCredentials();

    try {
        const response = await fetch(getGistUrl(gistId), {
            headers: getGistHeaders(gistToken)
        });
        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} - Gist not found or not accessible. Please verify STATE_GIST_ID secret is correct.`);
        }
        const gist = await response.json();
        const content = gist.files[GIST_STATE_FILE]?.content;
        if (content) {
            const state = JSON.parse(content);
            log(`[state] Loaded from Gist: last_id=${state.last_id || 'none'}, user_id=${state.user_id || 'none'}`);
            return state;
        }
        log(`[state] Gist exists but ${GIST_STATE_FILE} not found, starting fresh`);
        return { last_id: null, user_id: null };
    } catch (e) {
        logError(`[state] CRITICAL: Could not load from Gist: ${e.message}`);
        throw e;
    }
}

async function saveState(lastId, userId) {
    const { gistId, gistToken } = getGistCredentials();

    try {
        const response = await fetch(getGistUrl(gistId), {
            method: 'PATCH',
            headers: { ...getGistHeaders(gistToken), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: {
                    [GIST_STATE_FILE]: {
                        content: JSON.stringify({ last_id: lastId, user_id: userId })
                    }
                }
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
        }
        log(`[state] Saved to Gist: ${lastId}`);
    } catch (e) {
        logError(`[state] CRITICAL: Could not save to Gist: ${e.message}`);
        throw e;
    }
}

function chunkTelegramMessage(text, chunkSize = TELEGRAM_MAX_MESSAGE_LENGTH) {
    if (text.length <= chunkSize) {
        return [text];
    }
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);
        let splitAt = text.lastIndexOf('\n', end);
        if (splitAt === -1 || splitAt <= start) {
            splitAt = end;
        }
        chunks.push(text.substring(start, splitAt));
        start = splitAt === end ? end : splitAt + 1;
    }
    return chunks;
}

function extractTweetText(tweet) {
    return (tweet.note_tweet?.text ?? tweet.text ?? "").trim();
}

function buildMessage(username, tweet) {
    const tweetUrl = `https://x.com/${username}/status/${tweet.id}`;
    const text = extractTweetText(tweet);

    return `${text}\n\nSource: ${tweetUrl}`;
}

async function sendToTelegram({ bot, chatId, message, disablePreview = false, dryRun = false }) {
    if (dryRun) {
        log(`[dry-run] Telegram message:\n${message}\n${'-'.repeat(40)}`);
        return;
    }

    const chunks = chunkTelegramMessage(message);

    for (const part of chunks) {
        try {
            await bot.api.sendMessage(chatId, part, {
                disable_web_page_preview: disablePreview
            });
        } catch (e) {
            logError(`[telegram] ${e.message}`);
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
        throw new Error("Missing X_BEARER_TOKEN.");
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

    const tweets = await client.v2.userTimeline(userId, {
        since_id: sinceId || undefined,
        max_results: Math.min(X_API_MAX_RESULTS, maxPerRun),
        "tweet.fields": ["note_tweet"],
        exclude: exclude.length ? exclude : undefined
    });

    // tweets.data is the API response; .data within it is the array of tweet objects
    const data = tweets.data?.data || [];

    // Sort oldest -> newest (API returns newest first)
    // Tweet IDs are numeric strings that sort lexicographically
    data.sort((a, b) => a.id.localeCompare(b.id));

    return data;
}

// -------------------------
// Core run
// -------------------------
async function getUserIdWithCache(client, username, state) {
    if (state.user_id) {
        return state.user_id;
    }

    log(`[info] Looking up user ID for @${username}`);
    return await getUserId(client, username);
}

async function processTweets(tweets, { username, tgToken, chatId, disablePreview, dryRun, userId }) {
    const bot = dryRun ? null : new Bot(tgToken);

    for (const tweet of tweets) {
        const msg = buildMessage(username, tweet);
        await sendToTelegram({ bot, chatId, message: msg, disablePreview, dryRun });
        await saveState(tweet.id, userId);
        log(`[posted] ${tweet.id}`);
    }
}

async function run(args) {
    const { username, includeRetweets, includeReplies, maxPerRun, disablePreview, dryRun } = args;
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;

    if (!tgToken || !tgChat) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
    }

    const client = getClient();

    // Use cached user_id from Gist if available, otherwise look up and cache
    const state = await loadState();
    let userId = await getUserIdWithCache(client, username, state);

    // Save user_id if it was just fetched
    if (!state.user_id) {
        await saveState(state.last_id, userId);
    }

    try {
        const tweets = await fetchNewTweets(client, userId, state.last_id, includeRetweets, includeReplies, maxPerRun);

        if (tweets.length === 0) {
            log("[info] No new tweets.");
            return;
        }

        log(`[info] Found ${tweets.length} new tweet(s)`);

        await processTweets(
            tweets, { username, tgToken, chatId: tgChat, disablePreview, dryRun, userId }
        );

        log(`[done] Posted ${tweets.length} tweet(s)`);
    } catch (e) {
        // Handle X API rate limiting
        if (e.code === 429 || e.statusCode === 429 || e.response?.status === 429) {
            log("[warning] X API rate limit reached — skipping this run.");
            return;
        }
        throw e;
    }
}

// -------------------------
// Main / CLI
// -------------------------
async function main() {
    const argv = await yargs(hideBin(process.argv))
        .parserConfiguration({ 'camel-case-expansion': true })
        .option('username', { default: process.env.X_USERNAME, describe: 'X handle without @', demandOption: !process.env.X_USERNAME })
        .option('include-retweets', { type: 'boolean', default: false, describe: 'Also post retweets' })
        .option('include-replies', { type: 'boolean', default: false, describe: 'Also post replies' })
        .option('max-per-run', { default: DEFAULT_MAX_PER_RUN, type: 'number', describe: 'Max tweets to post per run' })
        .option('disable-preview', { type: 'boolean', default: false, describe: 'Disable Telegram link previews' })
        .option('dry-run', { type: 'boolean', default: false, describe: 'Do everything except sending to Telegram' })
        .help()
        .argv;

    log(`[start] Checking @${argv.username}`);

    try {
        await run(argv);
    } catch (e) {
        logError(`[error] ${e.message}`);
        process.exit(1);
    }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    main();
}
