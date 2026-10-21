# subwheel-ai (Telegram + GSubz + Gemini)

Telegram bot (webhook, deployable on Vercel) that lists and sells data plans through GSubz, driven by Gemini.
Customers chat in plain language ("2GB for Airtel", "buy data for oba"); money only moves after they tap a Confirm button.

## Features
- **Plans:** lists MTN, Glo, Airtel and 9mobile plans from GSubz, grouped by type (SME, Gifting, Corporate).
- **Buying:** Gemini gathers network, plan and number; the server looks up the real price and asks for a Confirm/Cancel tap. Purchases above `MAX_PURCHASE_NGN` (default 10000) are blocked.
- **Saved contacts:** "save 08012345678 glo as oba", then "buy 1GB for oba". Update, list and delete are supported. Contacts are private to each Telegram user.
- **The usual:** when buying for a number, the bot offers that user's last successful plan for it first, at today's price.
- **Purchase log:** every purchase is recorded in Postgres (processing / success / failed / unknown, with the GSubz reference).
- **Admin:** `/balance` (or asking the bot) shows the GSubz wallet balance and your funding account text. Admins only.
- **Commands:** `/login <code>`, `/logout`, `/reset`, `/help`, `/balance` (admin).

## Setup per customer
1. Create a bot with @BotFather -> `TELEGRAM_BOT_TOKEN`.
2. Get a Gemini key (aistudio.google.com) -> `GEMINI_API_KEY`.
3. Get the GSubz API key (gsubz.com/dashboard/key.php) -> `GSUBZ_API_KEY`.
4. Create an Upstash Redis database -> `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (the REST values, not the `redis://` string). Short-lived state: chat history, logins, pending confirmations.
5. Create a **new, empty** Neon Postgres database -> `DATABASE_URL` (use the pooled string, host contains `-pooler`). Durable data: contacts and the purchase log. Tables are created automatically on first use.
6. Pick `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`) and `ACCESS_CODE` (the passphrase customers use with `/login`).
7. Optional but recommended: `ADMIN_TELEGRAM_IDS` (your Telegram user ID, from @userinfobot) and `GSUBZ_ACCOUNT_DETAILS` (text shown by `/balance`).
8. Deploy to Vercel with those env vars (see `.env.example`), then redeploy after adding any variable.
9. Register the webhook: `node scripts/set-webhook.js https://<your-app>.vercel.app` (with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in your local `.env`).
10. In Telegram: `/login <ACCESS_CODE>`.

Give each customer their own Redis and Postgres databases. The logged-in user list is a single Redis key, so two bots sharing one Redis would share logins.

## Where data lives
| Store | What | Retention |
|---|---|---|
| Redis | chat history, pending confirmations, login-failure counters, update de-dupe | 24h / 10 min / 1h / 1h |
| Redis | logged-in Telegram user IDs | until `/logout` |
| Postgres | contacts, purchase log | permanent |

Chat messages are also sent to Google (Gemini) to generate replies; check Google's data terms for your API key.

## Security model
- Webhook only accepts requests carrying `TELEGRAM_WEBHOOK_SECRET`.
- Users must `/login <code>`; the code message is deleted from the chat; 5 wrong tries locks that Telegram user for 1 hour.
- Gemini cannot buy anything: `buy_data` only creates a Confirm/Cancel prompt. Plan and price come from GSubz, never from the model.
- A pending purchase can be claimed once, only by the user it was created for. Telegram redeliveries are de-duplicated.
- If GSubz gives an unclear answer, the bot reports "outcome unknown, don't retry" instead of guessing.
- **The bot spends the owner's GSubz wallet.** Use a strong `ACCESS_CODE`, test with small plans first, and only give access to people you trust.

## Not built yet
Airtime, customer payments (e.g. Flutterwave), per-user spending limits.
