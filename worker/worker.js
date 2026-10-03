/**
 * GeoGuessr bot — Cloudflare Worker (geo-bot.kviappsgames.workers.dev)
 *
 * Variables (Settings → Variables and Secrets):
 *   BOT_TOKEN     – bot token (required)
 *   CARD_CHAT_ID  – id of a private channel where the bot is an admin, e.g. -1001234567890.
 *                   Share cards are posted there once so Telegram stores them for free.
 *                   Optional: without it the card goes to the player's own chat with the bot
 *                   (works only for players who have pressed Start).
 *
 * Routes:
 *   POST /api/share-card        – share card upload from the mini app → { prepared_id, image_url }
 *   GET  /api/card/<file_id>.jpg – serves a stored card (stories / downloads)
 *   GET  /init                  – sets the Telegram webhook to this worker
 *   POST /                      – Telegram webhook updates
 */

const APP_URL = "https://vasiliy-katsyka.github.io/GeoGuessr/";
const APP_LINK = "https://t.me/geogur_bot/app";
const MAX_CARD_BYTES = 2 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- SHARE CARDS (mini app) ---
    if (url.pathname === "/api/share-card" || url.pathname.startsWith("/api/card/")) {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      try {
        if (url.pathname === "/api/share-card" && request.method === "POST") {
          return await shareCard(request, env);
        }
        const m = url.pathname.match(/^\/api\/card\/([^/]+?)(?:\.jpg)?$/);
        if (m && request.method === "GET") {
          return await serveCard(env, decodeURIComponent(m[1]), url.searchParams.has("download"));
        }
        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    // --- AUTOMATIC SETUP ROUTE ---
    if (url.pathname === "/init") {
      const webhookUrl = url.origin;
      const telegramUrl = `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${webhookUrl}`;
      const response = await fetch(telegramUrl);
      const result = await response.json();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- BOT LOGIC (Telegram webhook) ---
    if (request.method === "POST") {
      try {
        const update = await request.json();

        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text;

          if (text === "/start" || text.startsWith("/start ")) {
            const welcomeMessage =
              '<tg-emoji emoji-id="5399898266265475100">🌍</tg-emoji> <b>Дабро пожаловать в геогессср</b>\n\nКнопочку нажимаем и играем:';

            await sendTelegramMessage(env.BOT_TOKEN, chatId, welcomeMessage, {
              inline_keyboard: [[{ text: "🎮 Ыграть", web_app: { url: APP_URL } }]],
            });
          } else {
            await sendTelegramMessage(env.BOT_TOKEN, chatId, "Type /start to play!");
          }
        }
        return new Response("OK");
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }

    // Default response for random browser visits
    return new Response("Bot is running. Visit /init to setup webhook.");
  },
};

// ==================== SHARE CARDS ====================

// 1. Checks the player really is who Telegram says (initData signature).
// 2. Posts the card to CARD_CHAT_ID so Telegram stores it and gives a file id.
// 3. Prepares a photo message the player can send to any chat (WebApp.shareMessage).
async function shareCard(request, env) {
  const form = await request.formData();
  const user = await validateInitData(form.get("initData"), env.BOT_TOKEN);
  if (!user) return json({ error: "invalid initData" }, 401);

  const photo = form.get("photo");
  if (!photo || typeof photo === "string") return json({ error: "photo missing" }, 400);
  if (photo.size > MAX_CARD_BYTES) return json({ error: "photo too large" }, 413);
  if (!["image/jpeg", "image/png"].includes(photo.type)) return json({ error: "unsupported type" }, 415);

  const caption = String(form.get("caption") || "").slice(0, 900);

  const up = new FormData();
  up.append("chat_id", String(env.CARD_CHAT_ID || user.id));
  up.append("photo", photo, "card.jpg");
  up.append("disable_notification", "true");
  const msg = await tg(env, "sendPhoto", up);
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  const prepared = await tg(env, "savePreparedInlineMessage", {
    user_id: user.id,
    result: {
      type: "photo",
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
      photo_file_id: fileId,
      caption,
      reply_markup: { inline_keyboard: [[{ text: "🌍 Play GeoGuessr", url: APP_LINK }]] },
    },
    allow_user_chats: true,
    allow_bot_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
  });

  return json({
    prepared_id: prepared.id,
    image_url: `${new URL(request.url).origin}/api/card/${encodeURIComponent(fileId)}.jpg`,
  });
}

// Streams a stored card without exposing the bot token.
async function serveCard(env, fileId, download) {
  const file = await tg(env, "getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) return json({ error: "not found" }, 404);
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", ...CORS };
  if (download) headers["Content-Disposition"] = 'attachment; filename="geoguessr-card.jpg"';
  return new Response(res.body, { headers });
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function validateInitData(initData, token, maxAgeSec = 86400) {
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const enc = new TextEncoder();
  const hmac = async (key, msg) => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", k, enc.encode(msg));
  };
  const secret = await hmac(enc.encode("WebAppData"), token);
  const sig = new Uint8Array(await hmac(secret, dataCheck));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (maxAgeSec && Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

// ==================== HELPERS ====================

async function tg(env, method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

async function sendTelegramMessage(token, chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML", // allows the <tg-emoji> tag
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
