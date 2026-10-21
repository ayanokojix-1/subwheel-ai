// Redis (Upstash) holds short-lived state: Vercel functions are stateless.
const { Redis } = require("@upstash/redis");

// Works with a manual Upstash database or Vercel's Upstash integration.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

module.exports = { redis };
