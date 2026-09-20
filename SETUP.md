# Manual setup

Everything code-side is built (see `TASKS.md`), but the app talks to three external services that need real accounts/credentials only you can create: Google Cloud (OAuth + Calendar API), a Postgres database (Neon), and Anthropic (Claude API). This doc is the exact sequence — order matters because the Google OAuth client needs the extension's ID, which only exists after you load the extension once.

## 0. Install

```bash
npm install
```

## 1. Load the extension once (to get its ID)

The extension's ID is baked into the OAuth redirect URI, so this has to happen before you can create the Google OAuth client.

1. `chrome://extensions` → enable **Developer mode** (top right) → **Load unpacked** → select `extension/dist/`.
   - It'll show a config warning in the terminal if you build now (`extension/config.json` doesn't exist yet) — that's expected, ignore it for this step.
2. Note the extension's ID shown on its card (a 32-character string like `abcdefghijklmnopqrstuvwxyzabcdef`).
3. Your redirect URI is `https://<that-id>.chromiumapp.org/` — you'll paste this into Google Cloud in step 2.

Don't move or delete the `extension/dist/` folder afterward — Chrome derives the ID from the folder path for unpacked extensions, so relocating it changes the ID and breaks the redirect URI you registered.

## 2. Google Cloud — OAuth client + Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project (or pick an existing one).
2. **APIs & Services → Library** → search "Google Calendar API" → Enable.
3. **APIs & Services → OAuth consent screen**:
   - User type: External (unless you have a Workspace org to restrict to Internal).
   - Scopes: add `.../auth/calendar.events`, `.../auth/calendar.calendarlist.readonly` (lets the settings page list your calendars instead of asking for a raw ID), `.../auth/userinfo.email`, `openid`.
   - Test users: add your own Google account email (required while the app is in "Testing" publishing status — it will be, and that's fine for personal/dev use).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application** (not "Chrome extension" — the backend does the token exchange, not `chrome.identity`'s built-in Google flow).
   - Authorized redirect URIs: add `https://<your-extension-id>.chromiumapp.org/` from step 1.
5. Copy the generated **Client ID** and **Client Secret**.

You'll hit an "unverified app" warning when you actually sign in later — that's expected for an app in Testing mode with only your own account as a test user. Click through it (Advanced → Go to kinroo.ai (unsafe)).

## 3. Neon Postgres

1. Create a free project at [neon.tech](https://neon.tech).
2. Copy the pooled connection string (Neon's dashboard labels it — use the pooled one, not direct, since serverless functions open/close connections frequently).

## 4. Anthropic API key

1. Create a key at [console.anthropic.com](https://console.anthropic.com/) → API Keys.
2. This powers the LLM fallback parser and all image/PDF extraction — expect real usage once you start testing.

## 5. Fill in `web/.env`

```bash
cp web/.env.example web/.env
```

Fill in:
- `DATABASE_URL` — from step 3.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — from step 2.
- `SESSION_SECRET` — run `openssl rand -base64 32`.
- `TOKEN_ENCRYPTION_KEY` — run `openssl rand -base64 32` (a **different** value from `SESSION_SECRET`).
- `ANTHROPIC_API_KEY` — from step 4.

## 6. Fill in `extension/config.json`

```bash
cp extension/config.example.json extension/config.json
```

Set `googleClientId` to the Client ID from step 2. Leave `apiBase` as `http://localhost:3000` for local dev.

## 7. Run database migrations

```bash
cd web && npm run db:migrate
```

This applies `web/drizzle/0000_*.sql` and `0001_*.sql` (already generated from the schema) to your Neon database — creates `users`, `oauth_tokens`, `settings`, `llm_calls`, `email_identities`, `pending_email_actions`.

## 8. Run it

```bash
npm run dev:web         # backend at localhost:3000
npm run dev:extension   # rebuilds extension/dist/ on change
```

Reload the extension at `chrome://extensions` (the reload icon on its card — Chrome doesn't hot-reload extensions even in watch mode) to pick up the real `config.json`.

## 9. Walk through it

1. Click the extension icon → **Connect Google Calendar** → consent screen → click through the unverified-app warning → grant access.
2. Popup should show your email and a compose box.
3. Type `doctor's appointment at 9am tomorrow` → **Add** → review the confirm card → confirm → check it landed on your actual Google Calendar.
4. Type `what's on Saturday?` → should return a real answer based on your calendar.
5. Paste a screenshot of an event invite, or upload a photo of a flyer → confirm list should show one or more correctly-parsed candidates.

If step 9 fails, the most likely culprits in order: `extension/config.json` still has the placeholder client ID (rebuild after fixing), the redirect URI registered in Google Cloud doesn't match the extension's actual ID (re-check `chrome://extensions`), or `web/.env` wasn't picked up (`next dev` needs a restart after editing `.env`).

## 10. (Optional) Email ingest via SendGrid

Skip this section unless you're standing up the `add@<domain>` email channel — everything else works without it. Needs a domain you control (SendGrid Inbound Parse requires DNS access; you can't use a `gmail.com` address here).

1. Pick a subdomain to receive on, e.g. `mail.kinroo.ai` — this is `EMAIL_INGEST_DOMAIN`.
2. **SendGrid → Settings → Sender Authentication** — authenticate your root domain (adds the SPF/DKIM DNS records SendGrid gives you). Required for outbound confirmation emails to not get spam-filtered.
3. **SendGrid → Settings → Inbound Parse → Add Host & URL**:
   - Receiving domain/subdomain: `EMAIL_INGEST_DOMAIN` from step 1.
   - Destination URL: `https://<your-deployed-api>/api/email/inbound?key=<EMAIL_INGEST_WEBHOOK_SECRET>` — has to be a publicly reachable HTTPS URL, so this step needs `web/` actually deployed (see "Not covered here" below); it can't point at `localhost`.
   - This step also tells you the MX record to add at your DNS provider for that subdomain — add it and wait for propagation.
4. **SendGrid → Settings → API Keys → Create API Key** — needs "Mail Send" permission. This is `SENDGRID_API_KEY`.
5. Generate `EMAIL_INGEST_WEBHOOK_SECRET` with `openssl rand -base64 32` and fill in all three new vars in `web/.env` (and your Vercel project's env config, once deployed).
6. Test by emailing `add@<EMAIL_INGEST_DOMAIN>` something like "dentist appointment 9am tomorrow" from the address you signed into the extension with — you should get a confirmation email back asking to reply YES/NO.

This can't be verified from this repo alone (needs a real domain, DNS propagation, and a public deployment) — the code path (`api/email/inbound`) is covered by unit tests on its pure parsing logic (`lib/email-inbound.test.ts`) but not exercised end-to-end.

## 11. Deploying `web/` to Vercel

As of this writing, no Vercel project exists for kinroo.ai yet — this is the sequence to stand one up.

1. **Create the project**: Vercel → Add New → Project → import the `kinroo.ai` GitHub repo.
   - This repo is an npm-workspaces monorepo (`web/` + `extension/`), so set **Root Directory** to `web` in the project's settings — Vercel then runs the build from there and auto-detects Next.js. `extension/` is never deployed; it isn't a web app.
2. **Environment variables**: Project Settings → Environment Variables. Copy every value from your local `web/.env` in (`DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, plus `SENDGRID_API_KEY`/`EMAIL_INGEST_DOMAIN`/`EMAIL_INGEST_WEBHOOK_SECRET` if you're using email ingest). Use a separate Neon database/branch for production rather than pointing at your local dev database.
3. **Domain**: Project Settings → Domains → add `kinroo.ai`.
   - `kinroo.ai` is an **apex/root domain** — DNS doesn't allow a CNAME at the zone apex, so Vercel will ask for either (a) an **A record** pointing the apex at Vercel's IP, or (b) switching the domain's nameservers to Vercel's. A CNAME only applies if you also want a subdomain (e.g. `www.kinroo.ai`) pointing at Vercel. Vercel's domain-add flow tells you exactly which records to create once you add the domain, based on where `kinroo.ai` is currently registered/hosted.
   - Where `kinroo.ai` is registered determines who edits those DNS records — check the registrar before starting; it isn't currently attached to this Vercel account's domains.
4. **Extension**: for a build meant to talk to the deployed backend, set `apiBase` in your local (gitignored) `extension/config.json` to `https://kinroo.ai`. `host_permissions` in `extension/manifest.json` already includes `https://kinroo.ai/*` alongside the localhost dev entry, so no manifest change is needed.
5. **OAuth redirect URI**: the redirect URI (`https://<extension-id>.chromiumapp.org/`) is derived from the extension's ID, not from where the backend is hosted — deploying `web/` to Vercel doesn't require a new one. You *will* need a second redirect URI registered in Google Cloud later, separately, once the extension is published to the Chrome Web Store — publishing assigns a new, different extension ID than your local unpacked one.
6. **Email ingest** (if using it): now that there's a public HTTPS URL, come back to SETUP.md §10 step 3 and point SendGrid's Inbound Parse destination URL at `https://kinroo.ai/api/email/inbound?key=<EMAIL_INGEST_WEBHOOK_SECRET>`.
