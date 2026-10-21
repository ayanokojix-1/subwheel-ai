// Postgres (Neon) holds only durable data: saved contacts and the purchase log.
// Short-lived state (chat history, logins, pending confirmations) lives in Redis.
// Use Neon's *pooled* connection string (host contains "-pooler") as DATABASE_URL.
const { Pool, types } = require("pg");

// Telegram IDs fit safely in a JS number; don't return BIGINT as strings.
types.setTypeParser(20, Number);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 3,
});

const q = (text, params) => pool.query(text, params);

// Idempotent; runs once per cold start.
const ready = q(`
  CREATE TABLE IF NOT EXISTS contacts (
    user_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    network TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, name)
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id SERIAL PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    user_id BIGINT NOT NULL,
    phone TEXT NOT NULL,
    network TEXT NOT NULL,
    service_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    price NUMERIC NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'processing', -- processing | success | failed | unknown
    transaction_id TEXT,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS purchases_lookup_idx ON purchases (user_id, phone, created_at);
`);

// --- contacts (private to each Telegram user) ------------------------------------------

async function createContact(userId, name, phone, network) {
  await ready;
  const { rows } = await q(
    `INSERT INTO contacts (user_id, name, display_name, phone, network)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, name) DO NOTHING
     RETURNING display_name AS name, phone, network`,
    [userId, name.trim().toLowerCase(), name.trim(), phone, network.trim().toLowerCase()]
  );
  return rows[0]
    ? { saved: true, ...rows[0] }
    : { error: `A contact named "${name}" already exists — use update_contact to change it.` };
}

// Partial update — omitted fields keep their current value.
async function updateContact(userId, name, { phone, network } = {}) {
  await ready;
  const { rows } = await q(
    `UPDATE contacts SET
       phone = COALESCE($3, phone),
       network = COALESCE($4, network),
       updated_at = now()
     WHERE user_id = $1 AND name = $2
     RETURNING display_name AS name, phone, network`,
    [userId, name.trim().toLowerCase(), phone ?? null, network ? network.trim().toLowerCase() : null]
  );
  return rows[0] ? { updated: true, ...rows[0] } : { error: `No saved contact named "${name}".` };
}

async function findContact(userId, name) {
  await ready;
  const { rows } = await q(
    "SELECT display_name AS name, phone, network FROM contacts WHERE user_id = $1 AND name = $2",
    [userId, name.trim().toLowerCase()]
  );
  return rows[0] || { error: `No saved contact named "${name}".` };
}

async function listContacts(userId) {
  await ready;
  const { rows } = await q(
    "SELECT display_name AS name, phone, network FROM contacts WHERE user_id = $1 ORDER BY display_name ASC",
    [userId]
  );
  return { contacts: rows };
}

async function deleteContact(userId, name) {
  await ready;
  const { rowCount } = await q("DELETE FROM contacts WHERE user_id = $1 AND name = $2", [
    userId,
    name.trim().toLowerCase(),
  ]);
  return rowCount > 0 ? { deleted: true, name: name.trim() } : { error: `No saved contact named "${name}".` };
}

// --- purchase log -------------------------------------------------------------------------

async function startPurchase(requestId, userId, p) {
  await ready;
  await q(
    `INSERT INTO purchases (request_id, user_id, phone, network, service_id, plan_id, plan_name, price)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [requestId, userId, p.phone, p.network, p.serviceID, p.planID, p.name, p.price]
  );
}

async function finishPurchase(requestId, { outcome, transactionID, message }) {
  await ready;
  await q(
    "UPDATE purchases SET outcome = $2, transaction_id = $3, message = $4 WHERE request_id = $1",
    [requestId, outcome, transactionID != null ? String(transactionID) : null, message ?? null]
  );
}

async function getLastSuccessfulPurchase(userId, phone) {
  await ready;
  const { rows } = await q(
    `SELECT network, service_id AS "serviceID", plan_id AS "planID", created_at AS "purchasedAt"
     FROM purchases
     WHERE user_id = $1 AND phone = $2 AND outcome = 'success'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, phone]
  );
  return rows[0] || null;
}

module.exports = {
  createContact,
  updateContact,
  findContact,
  listContacts,
  deleteContact,
  startPurchase,
  finishPurchase,
  getLastSuccessfulPurchase,
};
