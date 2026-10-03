/**
 * GeoGuessr share cards — routes for the existing Cloudflare Worker (geo-bot.kviappsgames.workers.dev).
 *
 * Free: the card picture is stored by Telegram itself (no Firebase Storage / R2 / KV needed).
 *
 * Setup:
 *   1. Copy this file next to your worker code and wire it into your fetch handler:
 *
 *        import { handleShareRoutes } from './share-card.js';
 *        export default {
 *          async fetch(request, env, ctx) {
 *            const shared = await handleShareRoutes(request, env);
 *            if (shared) return shared;
 *            // ... your existing routes ...
 *          }
 *        };
 *
 *   2. Worker variables (Settings → Variables and Secrets):
 *        BOT_TOKEN      – the bot's token (you most likely have it already; rename below if yours differs)
 *        CARD_CHAT_ID   – id of a private channel where the bot is an admin, e.g. -1001234567890.
 *                         The bot posts each card there once to get a Telegram file id.
 *                         (If unset, the card is sent to the player's own chat with the bot instead,
 *                         which only works if they have pressed Start in the bot.)
 *
 * Routes:
 *   POST /api/share-card   multipart form: photo (image/jpeg ≤ 2 MB), initData, caption
 *        → { prepared_id, image_url }
 *   GET  /api/card/<file_id>.jpg   streams the stored picture (used for stories and downloads)
 */

const MAX_BYTES = 2 * 1024 * 1024;
const APP_LINK = 'https://t.me/geogur_bot/app';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function botToken(env) {
    return env.BOT_TOKEN;
}

async function tg(env, method, body) {
    const res = await fetch(`https://api.telegram.org/bot${botToken(env)}/${method}`, body instanceof FormData
        ? { method: 'POST', body }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
}

// Verifies Telegram.WebApp.initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
export async function validateInitData(initData, token, maxAgeSec = 86400) {
    const params = new URLSearchParams(initData || '');
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheck = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
    const enc = new TextEncoder();
    const hmac = async (key, msg) => {
        const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return crypto.subtle.sign('HMAC', k, enc.encode(msg));
    };
    const secret = await hmac(enc.encode('WebAppData'), token);
    const sig = new Uint8Array(await hmac(secret, dataCheck));
    const hex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (maxAgeSec && Date.now() / 1000 - authDate > maxAgeSec) return null;
    try { return JSON.parse(params.get('user')); } catch { return null; }
}

async function shareCard(request, env) {
    const form = await request.formData();
    const user = await validateInitData(form.get('initData'), botToken(env));
    if (!user) return json({ error: 'invalid initData' }, 401);

    const photo = form.get('photo');
    if (!photo || typeof photo === 'string') return json({ error: 'photo missing' }, 400);
    if (photo.size > MAX_BYTES) return json({ error: 'photo too large' }, 413);
    if (!['image/jpeg', 'image/png'].includes(photo.type)) return json({ error: 'unsupported type' }, 415);

    const caption = String(form.get('caption') || '').slice(0, 900);

    // 1. Let Telegram store the picture
    const up = new FormData();
    up.append('chat_id', String(env.CARD_CHAT_ID || user.id));
    up.append('photo', photo, 'card.jpg');
    up.append('disable_notification', 'true');
    const msg = await tg(env, 'sendPhoto', up);
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    // 2. Prepare a message the player can send to any chat via Telegram.WebApp.shareMessage()
    const prepared = await tg(env, 'savePreparedInlineMessage', {
        user_id: user.id,
        result: {
            type: 'photo',
            id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
            photo_file_id: fileId,
            caption,
            reply_markup: { inline_keyboard: [[{ text: '🌍 Play GeoGuessr', url: APP_LINK }]] }
        },
        allow_user_chats: true,
        allow_bot_chats: true,
        allow_group_chats: true,
        allow_channel_chats: true
    });

    const origin = new URL(request.url).origin;
    return json({ prepared_id: prepared.id, image_url: `${origin}/api/card/${encodeURIComponent(fileId)}.jpg` });
}

// Streams a stored card without exposing the bot token.
async function serveCard(env, fileId, download) {
    const file = await tg(env, 'getFile', { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${botToken(env)}/${file.file_path}`);
    if (!res.ok) return json({ error: 'not found' }, 404);
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ...CORS };
    if (download) headers['Content-Disposition'] = 'attachment; filename="geoguessr-card.jpg"';
    return new Response(res.body, { headers });
}

export async function handleShareRoutes(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/share-card') && !url.pathname.startsWith('/api/card/')) return null;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
        if (url.pathname === '/api/share-card' && request.method === 'POST') return await shareCard(request, env);
        const m = url.pathname.match(/^\/api\/card\/([^/]+?)(?:\.jpg)?$/);
        if (m && request.method === 'GET') return await serveCard(env, decodeURIComponent(m[1]), url.searchParams.has('download'));
        return json({ error: 'not found' }, 404);
    } catch (e) {
        return json({ error: String(e.message || e) }, 500);
    }
}
