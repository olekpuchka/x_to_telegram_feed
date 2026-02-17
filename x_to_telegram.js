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
const TELEGRAM_CAPTION_MAX_LENGTH = 1024;
const TELEGRAM_MEDIA_GROUP_MAX_SIZE = 10;
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

    // Clean up extra whitespace
    return text.replace(/\s+/g, ' ').replace(/\n\s+\n/g, '\n\n').trim();
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
        type: media.type === 'video' ? 'photo' : media.type, // Telegram expects 'photo' type for images
        url: media.type === 'video' ? media.preview_image_url : media.url,
        isVideoPreview: media.type === 'video'
    }));
}

function generateCaption(message) {
    return message.length <= TELEGRAM_CAPTION_MAX_LENGTH
        ? message
        : message.substring(0, TELEGRAM_CAPTION_MAX_LENGTH - 3) + '...';
}

async function sendTextMessageChunked(bot, chatId, message, disablePreview) {
    const chunks = chunkTelegramMessage(message);
    for (const part of chunks) {
        await bot.api.sendMessage(chatId, part, {
            disable_web_page_preview: disablePreview
        });
    }
}

async function sendToTelegram({ bot, chatId, message, media = [], disablePreview = false, dryRun = false }) {
    if (dryRun) {
        log(`[dry-run] Telegram message:\n${message}`);

        if (media.length > 0) {
            const mediaInfo = media.map(m => `${m.type}: ${m.url}`).join(', ');
            log(`[dry-run] Media: ${mediaInfo}`);
        }

        log('-'.repeat(40));
        return;
    }

    // Send media with caption if available
    if (media.length > 0) {
        try {
            if (media.length === 1) {
                await sendSingleMedia(bot, chatId, message, media[0]);
            } else {
                await sendMediaGroup(bot, chatId, message, media, disablePreview);
            }
        } catch (e) {
            logError(`[telegram] Error sending media: ${e.message}`);
            // Fallback to text only
            await sendTextMessageChunked(bot, chatId, message, disablePreview);
        }
    } else {
        // No media, send text only
        try {
            await sendTextMessageChunked(bot, chatId, message, disablePreview);
        } catch (e) {
            logError(`[telegram] ${e.message}`);
            throw e;
        }
    }
}

async function sendSingleMedia(bot, chatId, message, mediaItem) {
    const caption = generateCaption(message);
    // All media (including video previews) are sent as photos
    await bot.api.sendPhoto(chatId, mediaItem.url, { caption });
}

async function sendMediaGroup(bot, chatId, message, media, disablePreview) {
    const mediaGroup = media.slice(0, TELEGRAM_MEDIA_GROUP_MAX_SIZE).map((item, idx) => ({
        type: item.type,
        media: item.url,
        caption: idx === 0 ? generateCaption(message) : undefined
    }));

    await bot.api.sendMediaGroup(chatId, mediaGroup);

    // If caption was too long or there are more than max media items, send text separately
    if (message.length > TELEGRAM_CAPTION_MAX_LENGTH || media.length > TELEGRAM_MEDIA_GROUP_MAX_SIZE) {
        await sendTextMessageChunked(bot, chatId, message, disablePreview);
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

function logRateLimit(rateLimitInfo, endpoint = 'API') {
    if (!rateLimitInfo) return;

    const { limit, remaining, reset } = rateLimitInfo;

    if (limit !== undefined && remaining !== undefined && reset !== undefined) {
        const resetDate = new Date(reset * 1000);
        const now = new Date();
        const minutesUntilReset = Math.ceil((resetDate - now) / 1000 / 60);

        const percentage = Math.round((remaining / limit) * 100);
        const status = remaining === 0 ? '❌' : percentage < 20 ? '⚠️' : '✅';

        log(`[rate-limit] ${status} ${endpoint}: ${remaining}/${limit} requests remaining (${percentage}%) - resets in ${minutesUntilReset} min`);

        if (remaining === 0) {
            const resetTimeAmsterdam = resetDate.toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'long' });
            log(`[rate-limit] ⏰ Rate limit will reset at ${resetTimeAmsterdam} (Amsterdam)`);
        }
    }
}

async function getUserId(client, username) {
    const user = await client.v2.userByUsername(username);

    // Log rate limit for user lookup endpoint
    logRateLimit(user.rateLimit, 'User lookup');

    if (!user.data) {
        throw new Error(`User @${username} not found.`);
    }
    return user.data.id;
}

async function fetchNewTweets(client, userId, sinceId, includeRetweets, includeReplies, maxPerRun) {
    const exclude = [...(!includeRetweets ? ['retweets'] : []), ...(!includeReplies ? ['replies'] : [])];

    const tweets = await client.v2.userTimeline(userId, {
        since_id: sinceId || undefined,
        max_results: Math.min(X_API_MAX_RESULTS, maxPerRun),
        'tweet.fields': ['note_tweet', 'attachments', 'entities'],
        'expansions': ['attachments.media_keys'],
        'media.fields': ['url', 'preview_image_url', 'type'],
        exclude: exclude.length ? exclude : undefined
    });

    // Log rate limit for timeline endpoint
    logRateLimit(tweets.rateLimit, 'User timeline');

    // tweets.data is the API response; .data within it is the array of tweet objects
    const data = tweets.data?.data || [];
    const includes = tweets.data?.includes || {};

    // Sort oldest -> newest (API returns newest first)
    // Tweet IDs are numeric strings that sort lexicographically
    data.sort((a, b) => a.id.localeCompare(b.id));

    return { tweets: data, media: includes.media || [] };
}

async function fetchSpecificTweet(client, tweetId) {
    const response = await client.v2.singleTweet(tweetId, {
        'tweet.fields': ['note_tweet', 'attachments', 'entities'],
        'expansions': ['attachments.media_keys'],
        'media.fields': ['url', 'preview_image_url', 'type']
    });

    // Log rate limit for single tweet endpoint
    logRateLimit(response.rateLimit, 'Single tweet');

    const tweet = response.data;
    const includes = response.includes || {};

    if (!tweet) {
        throw new Error(`Tweet ${tweetId} not found.`);
    }

    return { tweets: [tweet], media: includes.media || [] };
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

async function processTweets(tweets, mediaData, { username, tgToken, chatId, disablePreview, dryRun, userId }) {
    const bot = dryRun ? null : new Bot(tgToken);

    for (const tweet of tweets) {
        const media = extractMedia(tweet, mediaData);
        const hasVideoPreview = media.some(m => m.isVideoPreview);
        const msg = buildMessage(username, tweet, hasVideoPreview);

        await sendToTelegram({ bot, chatId, message: msg, media, disablePreview, dryRun });
        await saveState(tweet.id, userId);

        const mediaInfo = media.length > 0
            ? ` (with ${media.length} media: ${media.map(m => m.isVideoPreview ? 'video preview' : m.type).join(', ')})`
            : '';

        log(`[posted] ${tweet.id}${mediaInfo}`);
    }
}

async function run(args) {
    const { username, includeRetweets, includeReplies, maxPerRun, disablePreview, dryRun, tweetId } = args;
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;

    if (!tgToken || !tgChat) {
        throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.');
    }

    const client = getClient();
    const state = await loadState();

    try {
        const userId = await getUserIdWithCache(client, username, state);
        let tweets, media;

        if (tweetId) {
            log(`[info] Fetching specific tweet: ${tweetId}`);
            ({ tweets, media } = await fetchSpecificTweet(client, tweetId));
        } else {
            ({ tweets, media } = await fetchNewTweets(client, userId, state.last_id, includeRetweets, includeReplies, maxPerRun));
        }

        if (tweets.length === 0) {
            log('[info] No new tweets.');
            return;
        }

        log(`[info] Found ${tweets.length} new tweet(s)`);

        await processTweets(tweets, media, { username, tgToken, chatId: tgChat, disablePreview, dryRun, userId });

        log(`[done] Posted ${tweets.length} tweet(s)`);
    } catch (e) {
        const has429Status = e.code === 429 || e.statusCode === 429 || e.response?.status === 429 || e.data?.status === 429;

        if (has429Status) {
            // X API free tier has very low per-endpoint rate limits (e.g. 1 req/15min for user timeline)
            // The rateLimit headers often reflect a different (app-level) bucket, so we can't trust them
            // to determine if we're actually rate-limited. A 429 status code is authoritative.
            log('[warning] X API rate limit reached (429) — skipping this run.');

            if (e.rateLimit) {
                const resetDate = new Date(e.rateLimit.reset * 1000);
                const now = new Date();
                const minutesUntilReset = Math.ceil((resetDate - now) / 1000 / 60);
                log(`[rate-limit] Resets in ${minutesUntilReset} min`);
            }

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
        .option('tweet-id', { type: 'string', describe: 'Specific tweet ID to post (overrides timeline fetching)' })
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
