// Access control. Knowing the bot's username is not enough: a Telegram user ID
// must be activated with the secret ACCESS_CODE (/login <code>).
const crypto = require("crypto");
const { redis } = require("./store");

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 60 * 60;

const safeEqual = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const isAuthorized = async (userId) => (await redis.sismember("authed", String(userId))) === 1;

// Returns { ok, reason }. reason: "locked" | "wrong" | "no-code-configured"
async function login(userId, code) {
  if (!process.env.ACCESS_CODE) return { ok: false, reason: "no-code-configured" };

  const failKey = `fails:${userId}`;
  const fails = Number(await redis.get(failKey)) || 0;
  if (fails >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };

  if (code && safeEqual(code, process.env.ACCESS_CODE)) {
    await redis.sadd("authed", String(userId));
    await redis.del(failKey);
    return { ok: true };
  }

  await redis.incr(failKey);
  await redis.expire(failKey, LOCKOUT_SECONDS);
  return { ok: false, reason: "wrong" };
}

// ADMIN_TELEGRAM_IDS: comma-separated Telegram user IDs. Unset = nobody is admin.
const isAdmin = (userId) =>
  (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map((x) => x.trim()).filter(Boolean).includes(String(userId));

const logout = (userId) => redis.srem("authed", String(userId));

module.exports = { isAuthorized, isAdmin, login, logout };
