// smeapi-lookup.js
// Exposes listPlans() for smeapi.com.ng — same interface as gsubz-lookup.js
// so you can swap providers without changing your Gemini tool wiring.

const SMEAPI_API_KEY = process.env.SMEAPI_API_KEY;

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

async function fetchAllPlans() {
  const res = await fetch("https://smeapi.com.ng/api/dataplans/", {
    headers: { Authorization: `Token ${SMEAPI_API_KEY}` },
  });
  const data = await res.json();
  return data.data || [];
}

async function getAllPlans() {
  if (!cache || Date.now() - cacheTime > CACHE_TTL_MS) {
    cache = await fetchAllPlans();
    cacheTime = Date.now();
  }
  return cache;
}

// network: "mtn" | "glo" | "airtel" | "9mobile"
// Returns every plan for that network, flattened and sorted by price.
async function listPlans(network) {
  const all = await getAllPlans();
  const target = network.toUpperCase();

  const matches = all
    .filter((p) => p.network === target)
    .map((p) => ({
      planID: p.id,
      displayName: `${p.name.trim()} - ${p.days} (${p.type})`,
      price: p.price,
    }))
    .sort((a, b) => a.price - b.price);

  return matches.length ? matches : { error: `No plans found for ${network}` };
}

const SMEAPI_NETWORK_IDS = {
  glo: 2, // confirmed via test purchase
  // mtn: ?,      // unconfirmed — verify before use
  // airtel: ?,   // unconfirmed — verify before use
  // "9mobile": ? // unconfirmed — verify before use
};

// network: "mtn" | "glo" | "airtel" | "9mobile"
// planID: the numeric `id` field from listPlans() results
// phone: customer's number, no country code
// portedNumber: defaults to false (most numbers aren't ported).
//   Only set to true on a retry after a failed purchase turns out to be
//   port-related — don't ask the customer upfront, it's rarely relevant.
function buildDataPurchasePayload(network, planID, phone, portedNumber = false) {
  const networkID = SMEAPI_NETWORK_IDS[network.toLowerCase()];
  if (!networkID) {
    return { error: `Network ID for "${network}" not confirmed yet — verify with SMEAPI before using.` };
  }
  return {
    network: networkID,
    data_plan: planID,
    phone,
    ported_number: portedNumber,
    ref: `DATA-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
  };
}

// In-memory dedup guard — prevents firing two purchases for the SAME
// confirmed request (e.g. Gemini calling buy_data twice for one customer
// confirmation). Keyed on idempotencyKey, which YOUR backend generates
// once per confirmed purchase decision — not on network/plan/phone, so
// genuinely buying the same plan for the same number twice (two separate
// confirmations) is never blocked.
// For production, back this with Redis or a DB instead of memory.
const seenIdempotencyKeys = new Map();
const DEDUP_WINDOW_MS = 60 * 1000; // 60 seconds — long enough to catch a same-turn glitch retry

function isDuplicateAttempt(idempotencyKey) {
  const now = Date.now();
  if (seenIdempotencyKeys.has(idempotencyKey)) {
    return true;
  }
  seenIdempotencyKeys.set(idempotencyKey, now);
  return false;
}

// idempotencyKey: generate this ONCE, right when the customer confirms
// the purchase (e.g. a UUID tied to that confirmation message/turn).
// Pass the SAME key if you ever legitimately retry the exact same
// confirmed request — otherwise generate a fresh key per confirmation.
async function buyData(network, planID, phone, idempotencyKey, portedNumber = false) {
  if (!idempotencyKey) {
    return { status: "ERROR", description: "idempotencyKey is required — generate one per confirmed purchase." };
  }
  if (isDuplicateAttempt(idempotencyKey)) {
    return {
      status: "BLOCKED_DUPLICATE",
      description: "This exact confirmed purchase was already processed. If you intended a separate purchase, confirm again to generate a new request.",
    };
  }

  const payload = buildDataPurchasePayload(network, planID, phone, portedNumber);
  if (payload.error) return payload;

  const res = await fetch("https://smeapi.com.ng/api/data/", {
    method: "POST",
    headers: {
      Authorization: `Token ${SMEAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  return { ...(await res.json()), ref: payload.ref };
}

module.exports = { listPlans, buyData };