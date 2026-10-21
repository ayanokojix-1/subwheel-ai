// GSubz (gsubz.com) client: plan listing + data purchase.
// Docs: https://documenter.getpostman.com/view/16767782/UyxhnnZz

const BASE = "https://api.gsubz.com/api";

// Our network names -> GSubz serviceIDs. Services that GSubz reports as
// inactive (e.g. mtn_cg_lite, mtncg, airtel_cg at the time of writing) are
// skipped automatically at runtime, so they can stay listed here.
const SERVICES = {
  mtn: [
    { id: "mtn_sme", type: "SME" },
    { id: "mtn_cg_lite", type: "SME 2.0" },
    { id: "mtn_gifting", type: "Gifting" },
    { id: "mtncg", type: "Corporate" },
  ],
  airtel: [
    { id: "airtel_sme", type: "SME" },
    { id: "airtel_cg", type: "Corporate" },
  ],
  glo: [
    { id: "glo_sme", type: "SME" },
    { id: "glo_data", type: "Gifting" },
  ],
  "9mobile": [{ id: "etisalat_data", type: "Gifting" }],
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // serviceID -> { at, plans }

async function fetchService(service) {
  const hit = cache.get(service.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.plans;

  const res = await fetch(`${BASE}/plans/?service=${service.id}`, {
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!Array.isArray(data.plans)) throw new Error(data.error || "no plans");

  const plans = data.plans.map((p) => ({
    serviceID: service.id,
    planID: String(p.value),
    type: service.type,
    name: p.displayName.trim().replace(/\s+/g, " "),
    price: Number(p.price),
  }));
  cache.set(service.id, { at: Date.now(), plans });
  return plans;
}

// Every available plan for a network, cheapest first.
async function listPlans(network) {
  const services = SERVICES[String(network).toLowerCase()];
  if (!services) return { error: `Unknown network "${network}"` };

  const results = await Promise.allSettled(services.map(fetchService));
  const plans = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => a.price - b.price);

  return plans.length ? plans : { error: `No plans available for ${network} right now` };
}

// Server-side lookup so the price/name we confirm and charge never come from
// the model.
async function findPlan(network, serviceID, planID) {
  const plans = await listPlans(network);
  if (plans.error) return null;
  return plans.find((p) => p.serviceID === serviceID && p.planID === String(planID)) || null;
}

// requestID doubles as our idempotency key on GSubz's side.
async function buyData({ serviceID, planID, phone, requestID }) {
  const form = new FormData();
  form.append("serviceID", serviceID);
  form.append("plan", String(planID));
  form.append("api", process.env.GSUBZ_API_KEY);
  form.append("amount", "");
  form.append("phone", phone);
  form.append("requestID", requestID);

  let body;
  try {
    const res = await fetch(`${BASE}/pay/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GSUBZ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(25000),
    });
    body = await res.json();
  } catch (err) {
    // We don't know whether GSubz processed it. Never auto-retry.
    return { outcome: "unknown", message: String(err.message || err) };
  }

  // HTTP/body "code" 200 can still carry status "failed", so check status.
  const content = body.content || body;
  const status = String(content.status || body.status || "").toUpperCase();
  const code = Number(body.code || content.code);

  if (code === 200 && status === "TRANSACTION_SUCCESSFUL") {
    return { outcome: "success", transactionID: content.transactionID };
  }
  if (status === "FAILED" || (code && code !== 200)) {
    return { outcome: "failed", message: content.api_response || body.description || status };
  }
  return { outcome: "unknown", message: JSON.stringify(body).slice(0, 300) };
}

async function getBalance() {
  const form = new FormData();
  form.append("api", process.env.GSUBZ_API_KEY);
  try {
    const res = await fetch(`${BASE}/balance/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GSUBZ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.balance !== undefined ? { balance: Number(data.balance) } : { error: "Could not read balance" };
  } catch {
    return { error: "Could not reach GSubz" };
  }
}

module.exports = { listPlans, findPlan, buyData, getBalance };
