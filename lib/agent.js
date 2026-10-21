// Gemini agent: chat history in Redis, contacts in Postgres, tool loop, and the purchase gate.
const crypto = require("crypto");
const { GoogleGenAI, Type } = require("@google/genai");
const db = require("./db");
const { redis } = require("./store");
const { listPlans, findPlan, getBalance } = require("./gsubz");
const { isAdmin } = require("./auth");
const telegram = require("./telegram");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const NETWORKS = ["mtn", "glo", "airtel", "9mobile"];
const HISTORY_LIMIT = 24; // contents entries kept per chat
const HISTORY_TTL = 60 * 60 * 24;
const PENDING_TTL = 60 * 10;
const MAX_TOOL_ROUNDS = 5;
const MAX_PURCHASE_NGN = Number(process.env.MAX_PURCHASE_NGN) || 10000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const tools = [
  {
    functionDeclarations: [
      {
        name: "list_data_plans",
        description: "Lists all available data plans for a mobile network, cheapest first. Each plan has a type (SME, Gifting, ...), serviceID, planID, name and price.",
        parameters: {
          type: Type.OBJECT,
          required: ["network"],
          properties: { network: { type: Type.STRING, enum: NETWORKS } },
        },
      },
      {
        name: "save_contact",
        description:
          'Saves a NEW phone number under a name, so future requests like "buy data for oba" resolve to the right number and network. Fails if that name is already saved — use update_contact to change an existing one instead.',
        parameters: {
          type: Type.OBJECT,
          required: ["name", "phone", "network"],
          properties: {
            name: { type: Type.STRING, description: 'The name to save the contact under, e.g. "oba"' },
            phone: { type: Type.STRING, description: "Contact's phone number, 11 digits (e.g. 08012345678)" },
            network: { type: Type.STRING, enum: NETWORKS },
          },
        },
      },
      {
        name: "update_contact",
        description:
          "Updates an existing saved contact's phone and/or network. Only include the field(s) that are actually changing — omitted fields are left as they are. Fails if no contact by that name exists.",
        parameters: {
          type: Type.OBJECT,
          required: ["name"],
          properties: {
            name: { type: Type.STRING, description: "The saved contact's name" },
            phone: { type: Type.STRING, description: "New phone number, only if it's changing" },
            network: { type: Type.STRING, enum: NETWORKS, description: "New network, only if it's changing" },
          },
        },
      },
      {
        name: "find_contact",
        description:
          "Looks up a previously saved contact by name to get their phone number and network. Call this when the customer refers to someone by name instead of giving a number.",
        parameters: { type: Type.OBJECT, required: ["name"], properties: { name: { type: Type.STRING } } },
      },
      {
        name: "list_contacts",
        description: "Lists every saved contact (name, phone, network). Call this when the customer asks what or who they have saved.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "delete_contact",
        description:
          "Removes a saved contact by name. Only call this when the customer explicitly asks to delete, remove, or forget a saved contact.",
        parameters: { type: Type.OBJECT, required: ["name"], properties: { name: { type: Type.STRING } } },
      },
      {
        name: "get_recent_purchase",
        description:
          'Looks up the customer\'s last successful data purchase for a phone number, to offer as "the usual" before listing plans from scratch. Returns network, serviceID, planID, name, type and current price if one exists.',
        parameters: { type: Type.OBJECT, required: ["phone"], properties: { phone: { type: Type.STRING } } },
      },
      {
        name: "get_account_details",
        description: "Returns the GSubz wallet balance and the account number used to fund it. Only for the business owner; fails for everyone else.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "buy_data",
        description:
          "Asks the customer to confirm a data purchase. This does NOT buy anything by itself: it shows the customer a Confirm/Cancel button with the real plan and price. Only call after the customer has told you the network, the plan and the phone number.",
        parameters: {
          type: Type.OBJECT,
          required: ["network", "serviceID", "planID", "phone"],
          properties: {
            network: { type: Type.STRING, enum: NETWORKS },
            serviceID: { type: Type.STRING, description: "serviceID of the chosen plan, exactly as returned by list_data_plans" },
            planID: { type: Type.STRING, description: "planID of the chosen plan, exactly as returned by list_data_plans" },
            phone: { type: Type.STRING, description: "Customer's phone number, 11 digits (e.g. 08012345678)" },
          },
        },
      },
    ],
  },
];

const systemInstruction = `You are a data sales assistant for subwheel ai data services on Telegram. You sell
mobile data plans for MTN, Glo, Airtel, and 9mobile.

Rules:
- Prices you get back are final customer prices — quote them exactly, don't do your own math.
- Wallet balance and account details are for the business owner only. Use get_account_details only if the customer asks for them; if it fails, just say you can't share that.
- Never guess a phone number. If unclear, ask.
- Keep responses short — this is a chat interface, not an essay. Plain text only: no Markdown, no asterisks, no bold. Use simple dashes or emoji for structure.
- If a tool call fails or returns no plans, tell the customer plainly and
  suggest trying again shortly. Don't make up plans.
- Before calling buy_data you must know: network, plan, and the phone number. Repeat them back in your own words only if something is unclear.
- buy_data does not complete a purchase. It shows the customer a Confirm/Cancel button. After calling it, tell the customer in one short line to tap Confirm. Never say a purchase succeeded — you will be told the result separately.
- If the customer wants the same plan twice, treat each as a separate purchase and call buy_data once per purchase, one at a time.
- Never call list_data_plans until the customer has told you which network
  (MTN, Glo, Airtel, 9mobile) they want. If they don't mention it, ask first —
  do not guess or search across networks to find a price match.
- If the customer's phrasing is ambiguous (e.g. unclear if they want multiple
  units), ask them to clarify exactly what they mean before proceeding.

Saved contacts:
- If the customer refers to a person by name instead of a number (e.g. "buy data
  for oba"), call find_contact to resolve their phone and network before doing
  anything else. If no contact is found, ask for the number.
- Only call save_contact when the customer explicitly asks you to save or remember
  a brand-new number under a name (e.g. "save 08012345678 glo as oba"). Don't save
  numbers on your own initiative during a purchase. If save_contact fails because
  the name's already taken, use update_contact instead (after confirming that's
  what they want).
- Only call update_contact when the customer wants to change an existing saved
  contact's number and/or network — pass only the field(s) that are actually
  changing, not the ones that are staying the same.
- Call list_contacts when the customer asks what or who they have saved.
- Only call delete_contact when the customer explicitly asks to delete, remove, or
  forget a saved contact by name. Confirm which name before deleting if there's
  any ambiguity, and tell the customer plainly once it's done.

The usual:
- Once you know which phone number you're buying for (saved contact or freshly
  given), call get_recent_purchase for that number before listing plans. If it
  returns a previous plan, offer it first in plain language (e.g. "The usual?
  2.5GB for ₦500 on Glo, or another plan?") and let the customer confirm or ask for
  something else. Only fall back to list_data_plans if there's no recent purchase
  or they want something different.

When presenting a list of data plans:
- Group them by type (SME, Gifting, Corporate) with a short header for each group.
- Within each group, sort by size (smallest to largest).
- Format each line as: size — duration — ₦price (nothing extra, no plan IDs shown to the customer).
- Skip near-duplicate plans (same size, same duration, negligible price difference) — show only the cheaper one.
- After the list, ask which one they want in plain language (e.g. "which one?"), not by asking for an ID.`;

// ---- history ---------------------------------------------------------------

const histKey = (chatId) => `hist:${chatId}`;

async function loadHistory(chatId) {
  return (await redis.get(histKey(chatId))) || [];
}

async function saveHistory(chatId, contents) {
  let trimmed = contents.slice(-HISTORY_LIMIT);
  // Must start on a plain user text turn, never on an orphaned tool result.
  const start = trimmed.findIndex((c) => c.role === "user" && c.parts.some((p) => p.text));
  trimmed = start === -1 ? [] : trimmed.slice(start);
  await redis.set(histKey(chatId), trimmed, { ex: HISTORY_TTL });
}

// Lets non-model events (e.g. a purchase result) show up in the conversation.
async function noteEvent(chatId, text) {
  const history = await loadHistory(chatId);
  history.push({ role: "user", parts: [{ text: `[system notice] ${text}` }] });
  await saveHistory(chatId, history);
}

const clearHistory = (chatId) => redis.del(histKey(chatId));

// ---- tools -----------------------------------------------------------------

async function runTool(call, ctx) {
  const { name, args } = call;

  if (name === "list_data_plans") {
    return listPlans(args.network);
  }

  if (name === "save_contact") {
    if (!/^0\d{10}$/.test(String(args.phone))) {
      return { error: "Invalid phone number. It must be 11 digits starting with 0. Ask the customer." };
    }
    return db.createContact(ctx.userId, args.name, args.phone, args.network);
  }
  if (name === "update_contact") {
    if (args.phone && !/^0\d{10}$/.test(String(args.phone))) {
      return { error: "Invalid phone number. It must be 11 digits starting with 0. Ask the customer." };
    }
    return db.updateContact(ctx.userId, args.name, { phone: args.phone, network: args.network });
  }
  if (name === "find_contact") return db.findContact(ctx.userId, args.name);
  if (name === "list_contacts") return db.listContacts(ctx.userId);
  if (name === "delete_contact") return db.deleteContact(ctx.userId, args.name);

  // Resolved against the live plan list so the offered price is never stale.
  if (name === "get_recent_purchase") {
    const last = await db.getLastSuccessfulPurchase(ctx.userId, args.phone);
    if (!last) return { error: "No previous purchase found for this number." };
    const plan = await findPlan(last.network, last.serviceID, last.planID);
    return plan
      ? { network: last.network, serviceID: plan.serviceID, planID: plan.planID, name: plan.name, type: plan.type, price: plan.price }
      : { network: last.network, note: "The previous plan is no longer available." };
  }

  if (name === "get_account_details") {
    if (!isAdmin(ctx.userId)) return { error: "Not allowed. Tell the customer you can't share that." };
    const bal = await getBalance();
    return { ...bal, fundingAccount: process.env.GSUBZ_ACCOUNT_DETAILS || "not configured" };
  }

  if (name === "buy_data") {
    if (ctx.pendingCreated) {
      return { error: "A confirmation is already waiting for the customer. Handle one purchase at a time." };
    }
    if (!/^0\d{10}$/.test(String(args.phone))) {
      return { error: "Invalid phone number. It must be 11 digits starting with 0. Ask the customer." };
    }
    const plan = await findPlan(args.network, args.serviceID, args.planID);
    if (!plan) return { error: "Plan not found. Call list_data_plans again and use an exact serviceID/planID." };
    if (plan.price > MAX_PURCHASE_NGN) {
      return { error: `This plan is above the ₦${MAX_PURCHASE_NGN} per-purchase limit. Tell the customer.` };
    }

    const id = crypto.randomUUID();
    await redis.set(
      `pending:${id}`,
      { chatId: ctx.chatId, userId: ctx.userId, serviceID: plan.serviceID, planID: plan.planID, phone: args.phone, name: plan.name, type: plan.type, price: plan.price, network: args.network },
      { ex: PENDING_TTL }
    );
    await telegram.sendMessage(
      ctx.chatId,
      `Please confirm your purchase:\n\n${args.network.toUpperCase()} ${plan.type} — ${plan.name}\nPrice: ₦${plan.price}\nPhone: ${args.phone}`,
      { reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `c:${id}` }, { text: "❌ Cancel", callback_data: `x:${id}` }]] } }
    );
    ctx.pendingCreated = true;
    return { status: "awaiting_customer_confirmation", note: "Confirmation buttons were sent. Tell the customer to tap Confirm." };
  }

  return { error: `Unknown tool ${name}` };
}

// ---- main entry ------------------------------------------------------------

async function chat(chatId, userId, text) {
  const contents = await loadHistory(chatId);
  contents.push({ role: "user", parts: [{ text }] });

  const ctx = { chatId, userId, pendingCreated: false };
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { tools, systemInstruction },
    });

    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      reply = "Sorry, I couldn't process that. Please try again.";
      break;
    }
    contents.push(content); // keep as-is (thought signatures matter)

    const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      reply = content.parts.map((p) => p.text || "").join("").trim();
      break;
    }

    const responses = [];
    for (const call of calls) {
      let result;
      try {
        result = await runTool(call, ctx);
      } catch (err) {
        console.error(`tool ${call.name} threw:`, err);
        result = { error: "Tool failed. Tell the customer to try again shortly." };
      }
      // Gemini wants an object; wrap arrays.
      responses.push({ functionResponse: { name: call.name, response: Array.isArray(result) ? { plans: result } : result } });
    }
    contents.push({ role: "user", parts: responses });
  }

  await saveHistory(chatId, contents);
  return reply || "Sorry, that took too long. Please try again.";
}

module.exports = { chat, noteEvent, clearHistory };
