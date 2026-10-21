# subwheel-ai (Telegram + GSubz + Gemini)

Telegram bot (webhook, Vercel) that lists and sells data plans through GSubz, driven by Gemini.

## Setup per customer
1. Create a bot with @BotFather -> `TELEGRAM_BOT_TOKEN`.
2. Get a Gemini key (aistudio.google.com) -> `GEMINI_API_KEY`.
3. Get the GSubz API key (gsubz.com/dashboard/key.php) -> `GSUBZ_API_KEY`.
4. Create an Upstash Redis database (Vercel Marketplace works) -> URL/token.
5. Pick `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`) and `ACCESS_CODE` (the passphrase for `/login`).
6. Deploy to Vercel with those env vars (see `.env.example`).
7. `node scripts/set-webhook.js https://<your-app>.vercel.app` (with the same env vars in `.env`).
8. In Telegram: `/login <ACCESS_CODE>`.

## Security model
- Webhook only accepts requests carrying `TELEGRAM_WEBHOOK_SECRET`.
- Users must `/login <code>`; 5 wrong tries locks that Telegram user for 1 hour.
- Purchases require a Confirm button tap; price/plan come from GSubz, never from the model.
- Updates are de-duplicated; a pending purchase can be claimed only once.
