#!/usr/bin/env node

/**
 * Post new X (Twitter) posts from a user to a Telegram channel.
 * Setup, environment variables, and usage: see README.md
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
const TELEGRAM_CAPTION_MAX_LENGTH = 1024;
const TELEGRAM_MEDIA_GROUP_MAX_SIZE = 10;
const X_API_MAX_RESULTS = 100;
const GIST_STATE_FILE = 'x-telegram-sync.json';

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

async function fetchGist(gistId, gistToken) {
    const response = await fetch(getGistUrl(gistId), {
        headers: getGistHeaders(gistToken)
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }
    return response.json();
}

async function updateGist(gistId, gistToken, content) {
    const response = await fetch(getGistUrl(gistId), {
        method: 'PATCH',
        headers: { ...getGistHeaders(gistToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            files: {
                [GIST_STATE_FILE]: { content: JSON.stringify(content) }
            }
        })
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${errorText}`);
    }
}

async function loadState() {
    const { gistId, gistToken } = getGistCredentials();

    try {
        const gist = await fetchGist(gistId, gistToken);
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
        await updateGist(gistId, gistToken, { last_id: lastId, user_id: userId });
        log(`[state] Saved to Gist: ${lastId}`);
    } catch (e) {
        logError(`[state] CRITICAL: Could not save to Gist: ${e.message}`);
        throw e;
    }
}

function chunkTelegramMessage(text, chunkSize = TELEGRAM_MAX_MESSAGE_LENGTH) {
    if (text.length <= chunkSize) return [text];

    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
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
    let text = (tweet.note_tweet?.text ?? tweet.text ?? "").trim();

    // Remove t.co URLs since the source link is already included
    const urls = tweet.entities?.urls || [];
    for (const url of urls) {
        if (url.url) {
            text = text.replaceAll(url.url, '');
        }
    }

    // Normalize whitespace: preserve newlines, collapse spaces within lines
    text = text.split('\n').map(line => line.replace(/ {2,}/g, ' ').trim()).join('\n');
    // Collapse 3+ consecutive newlines into 2
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

function buildMessage(username, tweet, hasVideoPreview = false) {
    const tweetUrl = `https://x.com/${username}/status/${tweet.id}`;
    const tweetText = extractTweetText(tweet);

    let message = tweetText;
    if (hasVideoPreview) {
        message += '\n\n🎬 Watch the full video via the Source link below 👇';
    }
    message += `\n\n🔗 Source:\n${tweetUrl}`;

    return message;
}

function extractMedia(tweet, mediaData) {
    const mediaKeys = tweet.attachments?.media_keys || [];
    if (mediaKeys.length === 0 || mediaData.length === 0) return [];

    // Create lookup map for O(1) access
    const mediaMap = new Map(mediaData.map(m => [m.media_key, m]));

    return mediaKeys.map(key => mediaMap.get(key)).filter(media => {
        if (!media) return false;
        // Photos have url, videos only have preview_image_url in free tier
        if (media.type === 'photo' && media.url) return true;
        if (media.type === 'video' && media.preview_image_url) return true;
        return false;
    }).map(media => ({
        url: media.type === 'video' ? media.preview_image_url : media.url,
        isVideoPreview: media.type === 'video'
    }));
}

function generateCaption(message) {
    const ellipsis = '...';
    return message.length <= TELEGRAM_CAPTION_MAX_LENGTH
        ? message
        : message.substring(0, TELEGRAM_CAPTION_MAX_LENGTH - ellipsis.length) + ellipsis;
}

async function sendTextMessageChunked(bot, chatId, message) {
    const chunks = chunkTelegramMessage(message);
    for (const part of chunks) {
        await bot.api.sendMessage(chatId, part);
    }
}

async function sendToTelegram({ bot, chatId, message, media = [] }) {
    if (media.length === 0) {
        await sendTextMessageChunked(bot, chatId, message);
        return;
    }

    // Send media with caption; fall back to text-only if the media send fails
    try {
        if (media.length === 1) {
            await sendSingleMedia(bot, chatId, message, media[0]);
        } else {
            await sendMediaGroup(bot, chatId, message, media);
        }
    } catch (e) {
        logError(`[telegram] Media send failed, falling back to text: ${e.message}`);
        await sendTextMessageChunked(bot, chatId, message);
    }
}

async function sendSingleMedia(bot, chatId, message, mediaItem) {
    const caption = generateCaption(message);
    // All media (including video previews) are sent as photos
    await bot.api.sendPhoto(chatId, mediaItem.url, { caption });
}

async function sendMediaGroup(bot, chatId, message, media) {
    const mediaGroup = media.slice(0, TELEGRAM_MEDIA_GROUP_MAX_SIZE).map((item, idx) => ({
        // Photos and video previews are both sent to Telegram as photos
        type: 'photo',
        media: item.url,
        caption: idx === 0 ? generateCaption(message) : undefined
    }));

    await bot.api.sendMediaGroup(chatId, mediaGroup);

    // If caption was too long or there are more than max media items, send text separately
    if (message.length > TELEGRAM_CAPTION_MAX_LENGTH || media.length > TELEGRAM_MEDIA_GROUP_MAX_SIZE) {
        await sendTextMessageChunked(bot, chatId, message);
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

async function fetchNewTweets(client, userId, sinceId, maxPerRun) {
    const tweets = await client.v2.userTimeline(userId, {
        since_id: sinceId || undefined,
        max_results: Math.min(X_API_MAX_RESULTS, maxPerRun),
        'tweet.fields': ['note_tweet', 'attachments', 'entities'],
        'expansions': ['attachments.media_keys'],
        'media.fields': ['url', 'preview_image_url', 'type'],
        exclude: ['retweets', 'replies']
    });

    // tweets.data is the API response; .data within it is the array of tweet objects
    const data = tweets.data?.data || [];
    const includes = tweets.data?.includes || {};

    // Sort oldest -> newest (API returns newest first)
    // Tweet IDs are numeric strings that sort lexicographically
    data.sort((a, b) => a.id.localeCompare(b.id));

    return { tweets: data, media: includes.media || [] };
}

// -------------------------
// Core run
// -------------------------
async function getUserIdWithCache(client, username, state) {
    if (state.user_id) {
        return state.user_id;
    }

    log(`[info] Looking up user ID for @${username}`);
    const userId = await getUserId(client, username);

    // Cache the user_id immediately to avoid redundant lookups
    await saveState(state.last_id, userId);
    return userId;
}

async function processTweets(tweets, mediaData, { username, tgToken, chatId, userId }) {
    const bot = new Bot(tgToken);

    for (const tweet of tweets) {
        const media = extractMedia(tweet, mediaData);
        const hasVideoPreview = media.some(m => m.isVideoPreview);
        const msg = buildMessage(username, tweet, hasVideoPreview);

        await sendToTelegram({ bot, chatId, message: msg, media });
        await saveState(tweet.id, userId);

        const mediaInfo = media.length > 0
            ? ` (with ${media.length} media: ${media.map(m => m.isVideoPreview ? 'video preview' : 'photo').join(', ')})`
            : '';

        log(`[posted] ${tweet.id}${mediaInfo}`);
    }
}

async function run(args) {
    const { username, maxPerRun } = args;
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;

    if (!tgToken || !tgChat) {
        throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.');
    }

    const client = getClient();
    const state = await loadState();

    try {
        const userId = await getUserIdWithCache(client, username, state);
        const { tweets, media } = await fetchNewTweets(client, userId, state.last_id, maxPerRun);

        if (tweets.length === 0) {
            log('[info] No new tweets.');
            return;
        }

        log(`[info] Found ${tweets.length} new tweet(s)`);

        await processTweets(tweets, media, { username, tgToken, chatId: tgChat, userId });

        log(`[done] Posted ${tweets.length} tweet(s)`);
    } catch (e) {
        const statusCode = e.code ?? e.statusCode ?? e.response?.status ?? e.data?.status;

        if (statusCode === 429) {
            log('[warning] X API rate limit reached — skipping this run.');
            return;
        }

        if (statusCode === 402) {
            log('[warning] X API returned 402 Payment Required — the current API plan does not include this endpoint. Skipping this run.');
            return;
        }

        // Transient server-side errors (X API outage/hiccup). Skip this run;
        // the next scheduled run will pick up from the same last_id.
        if (statusCode >= 500 && statusCode <= 599) {
            log(`[warning] X API returned ${statusCode} — transient server error. Skipping this run.`);
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
        .option('max-per-run', { default: DEFAULT_MAX_PER_RUN, type: 'number', describe: 'Max tweets to post per run' })
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
