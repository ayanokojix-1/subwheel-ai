// Telegram webhook entry point (Vercel serverless function).
const { redis } = require("../lib/store");
const db = require("../lib/db");
const telegram = require("../lib/telegram");
const { isAuthorized, isAdmin, login, logout } = require("../lib/auth");
const { chat, noteEvent, clearHistory } = require("../lib/agent");
const { buyData, getBalance } = require("../lib/gsubz");

const LOGIN_HINT = "🔒 This bot is private. Send /login followed by your access code.";

async function handleLogin(msg, code) {
  const { id: chatId } = msg.chat;
  // Remove the message holding the secret from the chat.
  await telegram.deleteMessage(chatId, msg.message_id);

  if (await isAuthorized(msg.from.id)) {
    return telegram.sendMessage(chatId, "You're already logged in. How can I help?");
  }
  if (!code) return telegram.sendMessage(chatId, LOGIN_HINT);

  const result = await login(msg.from.id, code);
  if (result.ok) {
    return telegram.sendMessage(chatId, "✅ Access granted. Ask me for data plans, e.g. \"show me MTN plans\".");
  }
  const reasons = {
    locked: "Too many failed attempts. Try again in an hour.",
    "no-code-configured": "This bot hasn't been configured yet.",
    wrong: "❌ Wrong access code.",
  };
  return telegram.sendMessage(chatId, reasons[result.reason]);
}

async function handleMessage(msg) {
  if (msg.chat.type !== "private" || !msg.from || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // /login <code> and the /start <code> deep link
  const m = text.match(/^\/(login|start)(?:@\w+)?(?:\s+(.+))?$/i);
  if (m && (m[1].toLowerCase() === "login" || m[2])) return handleLogin(msg, m[2]?.trim());

  if (!(await isAuthorized(msg.from.id))) return telegram.sendMessage(chatId, LOGIN_HINT);

  if (/^\/start(@\w+)?$/i.test(text) || /^\/help(@\w+)?$/i.test(text)) {
    return telegram.sendMessage(chatId, "Hi! I can list data plans and buy data for MTN, Glo, Airtel and 9mobile.\n\n/reset — start a new conversation\n/logout — remove your access");
  }
  if (/^\/balance(@\w+)?$/i.test(text)) {
    if (!isAdmin(msg.from.id)) return telegram.sendMessage(chatId, "Not allowed.");
    const bal = await getBalance();
    const funding = process.env.GSUBZ_ACCOUNT_DETAILS || "not configured";
    return telegram.sendMessage(chatId, bal.error ? bal.error : `Wallet balance: ₦${bal.balance}\nFund via: ${funding}`);
  }
  if (/^\/reset(@\w+)?$/i.test(text)) {
    await clearHistory(chatId);
    return telegram.sendMessage(chatId, "Conversation cleared.");
  }
  if (/^\/logout(@\w+)?$/i.test(text)) {
    await logout(msg.from.id);
    await clearHistory(chatId);
    return telegram.sendMessage(chatId, "Logged out.");
  }

  await telegram.sendTyping(chatId);
  const reply = await chat(chatId, msg.from.id, text);
  if (reply) await telegram.sendMessage(chatId, reply);
}

async function handleCallback(cb) {
  const [action, id] = String(cb.data || "").split(":");
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (!chatId || !id || !["c", "x"].includes(action)) return telegram.answerCallback(cb.id);

  if (!(await isAuthorized(cb.from.id))) return telegram.answerCallback(cb.id, "Not authorized.");

  // GETDEL makes the claim atomic: a double-tap or Telegram retry gets null.
  const pending = await redis.getdel(`pending:${id}`);
  if (!pending) {
    await telegram.answerCallback(cb.id, "This request expired or was already handled.");
    return telegram.editMessage(chatId, messageId, "⌛ This confirmation is no longer valid.");
  }
  if (pending.userId !== cb.from.id) {
    // Not theirs: put it back untouched.
    await redis.set(`pending:${id}`, pending, { ex: 600 });
    return telegram.answerCallback(cb.id, "Not your request.");
  }

  const summary = `${pending.network.toUpperCase()} ${pending.name} (₦${pending.price}) → ${pending.phone}`;

  if (action === "x") {
    await telegram.answerCallback(cb.id, "Cancelled");
    await telegram.editMessage(chatId, messageId, `❌ Cancelled: ${summary}`);
    return noteEvent(chatId, `Customer cancelled the purchase: ${summary}`);
  }

  await telegram.answerCallback(cb.id, "Processing…");
  await telegram.editMessage(chatId, messageId, `⏳ Processing: ${summary}`);

  // Logged before calling GSubz, so a crash mid-purchase still leaves a
  // "processing" row to reconcile.
  await db.startPurchase(id, cb.from.id, pending);
  const result = await buyData({ serviceID: pending.serviceID, planID: pending.planID, phone: pending.phone, requestID: id });
  await db.finishPurchase(id, result).catch((e) => console.error("finishPurchase failed", id, e));

  let text;
  if (result.outcome === "success") {
    text = `✅ Done! ${summary}\nRef: ${result.transactionID}`;
  } else if (result.outcome === "failed") {
    const reason = /INSUFFICIENT/i.test(result.message || "")
      ? "The service is temporarily unable to process purchases. Please contact the admin."
      : result.message || "";
    text = `❌ Purchase failed: ${summary}\n${reason}\nYou were not charged. You can try again.`;
  } else {
    text = `⚠️ We couldn't confirm the outcome of: ${summary}\nPlease don't retry yet. Ref: ${id}\nCheck with the admin first.`;
    console.error("UNKNOWN purchase outcome", id, result.message);
  }
  await telegram.editMessage(chatId, messageId, text);
  return noteEvent(chatId, `Purchase result: ${text.split("\n")[0]}`);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  // Only Telegram knows this secret (set via setWebhook).
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).end();
  }

  const update = req.body || {};
  try {
    // Telegram redelivers updates it thinks failed; never process one twice.
    const fresh = await redis.set(`upd:${update.update_id}`, 1, { nx: true, ex: 3600 });
    if (!fresh) return res.status(200).end();

    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("webhook error:", err);
    const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id;
    if (chatId) await telegram.sendMessage(chatId, "Something went wrong. Please try again.").catch(() => {});
  }
  // Always 200 so Telegram doesn't hammer us with retries.
  return res.status(200).end();
};
