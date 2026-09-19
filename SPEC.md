# kinroo.ai — v1 Spec: Compose-to-Calendar

_Written: 2026-09-18_

## What kinroo.ai is

A natural-language interface layer on top of Google Calendar — not a calendar app. kinroo never owns event data; Google Calendar is the only source of truth. kinroo's job is turning plain English into Calendar API calls (and, later, turning Calendar data into plain English answers).

## v1 scope

**In scope:**
1. Chrome extension, compose mode — type free text in the popup, get a Google Calendar event.
2. Chrome extension, query mode — ask a natural-language question about the calendar, get an answer.
3. Single Google account per user. Confirm-before-write on every create/update.

**Explicitly out of scope for v1** (do not build, but see "Family-readiness notes" below for the conventions that keep these open):
- Page-scan extraction (click extension on an open page, find events in visible text) — phase 2.
- Email ingest (`add@kinroo.ai`) — phase 3.
- WhatsApp/SMS — phase 4.
- Family / multi-account / shared calendars.
- Auto-commit without confirmation (modeled as a settings flag, not built).
- Proactive notifications (morning briefing, conflict alerts).

## Why this shape (context for future readers)

An earlier prototype (`simple-family-calendar`, not in this repo) built its own Postgres `events` table with one-way Google Calendar import, plus a full family-members/co-manager data model, and explicitly deprioritized the browser extension in favor of WhatsApp/email. That product bet is not this one. This spec inverts both calls:

- Google Calendar is read/write from day one — no shadow event store — because that's what "we're not rebuilding a calendar" means in practice, and because Google's own sharing/ACL model gives us a much cheaper path to family support later (see below) than building permissions ourselves.
- The Chrome extension ships first because it's the fastest loop to validate whether NLP-driven event creation is accurate and trustworthy enough to build the other channels on top of.

## Architecture

```
Chrome extension (Manifest V3)
  popup — compose box + confirm-preview UI (v1)
  background service worker — holds session token, calls backend
        │
        ▼
Next.js app (web/, deployed to Vercel)
  route handlers = the entire backend API
  minimal pages = OAuth login/callback, settings (later)
        │
        ├──► Google Calendar API (events.insert, events.list) — the data
        ├──► Claude API — LLM fallback parsing
        └──► Postgres (Neon) — thin: users, oauth tokens, settings, LLM telemetry only
```

No separate server process. No events table. If a future channel (email, WhatsApp) needs the same pipeline, it becomes another route handler calling the same parsing/calendar functions — not a new service.

## Data model (v1)

Only what's needed to authenticate a user and remember their preferences. No events, no family members.

```
users
  id                  uuid pk
  google_account_id   text unique
  email               text
  name                text
  created_at          timestamptz

oauth_tokens
  user_id             uuid fk -> users.id
  access_token        text (encrypted at rest)
  refresh_token       text (encrypted at rest)
  expires_at          timestamptz
  scope               text

settings
  user_id                       uuid fk -> users.id
  timezone                      text
  default_event_duration_min    int default 30
  confirm_before_write          boolean default true   -- always true in v1; UI to change it ships later
  default_calendar_id           text default 'primary'

llm_calls   -- telemetry, cheap to add now, valuable before any architecture decisions later
  id                  uuid pk
  user_id             uuid fk -> users.id
  channel             text        -- 'extension-compose', 'extension-query', ...
  used_llm            boolean     -- false = fast-path regex handled it alone
  model               text nullable
  intent              text        -- 'create' | 'query' | 'unknown'
  prompt_tokens       int nullable
  completion_tokens   int nullable
  latency_ms          int
  cost_usd            numeric nullable
  confirmed           boolean nullable   -- did the user accept the preview?
  user_corrected      boolean default false
  error               text nullable
  created_at          timestamptz
```

## Family-readiness notes (do not build now — just don't foreclose it)

Because Google Calendar is the real backend, "family" can eventually mean *a Google Calendar shared with multiple accounts via Google's own ACLs* — not a permissions system we build ourselves. To keep that path open at zero cost today:

- Every Calendar API call takes an explicit `calendarId` parameter (`settings.default_calendar_id`, currently always `'primary'`). Never hardcode `'primary'` inline.
- If/when event tagging ships (e.g. "for Maya"), store it in Google's `extendedProperties` on the event, not in the title string — existing events then need no migration.
- The LLM extraction schema may parse an optional assignee/subject even though v1 ignores it — additive later, not a breaking schema change.
- When email/phone channels arrive, identity resolves through a lookup table (`address -> user_id`), not a column on `users` — so multiple people can register against a shared context without restructuring.
- Application code takes `userId`/`calendarId` as explicit parameters everywhere — no global "current user" singleton.

## Auth flow

1. Extension popup, unauthenticated state: "Connect Google Calendar" button opens `web`'s hosted OAuth flow in a new tab (`/login` → Google consent → `/api/auth/google/callback`).
2. Scope requested: `https://www.googleapis.com/auth/calendar.events` only (not full calendar scope — least privilege).
3. Backend exchanges the code, stores refresh token in `oauth_tokens`, creates/updates the `users` row, issues a session token.
4. Session token is handed back to the extension (mechanism TBD at implementation time — likely `chrome.identity.launchWebAuthFlow` or a success-page → `postMessage` → content script relay) and stored in `chrome.storage.local`.
5. All subsequent extension → backend calls carry the session token; the backend maps it to a user and uses that user's stored Google refresh token to call the Calendar API server-side. The extension never sees the Google token directly.

## Core pipeline (shared shape, extension is the only caller in v1)

```
text ──► intent classification ──► extraction ──► confirm ──► write/read
```

1. **Intent classification** — regex/heuristic first pass: does this look like a creation ("X at Y", "schedule...", a weekday/date + time) or a question ("do I have", "what's on", "am I free")? Ambiguous or low-confidence → Claude call classifies intent as part of the same request that does extraction.
2. **Extraction (create)** — pull `{ title, start, end, timezone, location? }` from text.
   - Fast path: regex/date-library parsing (e.g. relative dates, "Xam/pm") for common phrasings.
   - Fallback: Claude call with a structured tool-call schema when the fast path can't confidently fill required fields.
   - No explicit duration stated → default from `settings.default_event_duration_min`.
3. **Confirm** — popup shows the parsed event (editable title/time) before any write. This is non-negotiable in v1 regardless of parser confidence.
4. **Write** — on confirm, `events.insert` against `settings.default_calendar_id`.
5. **Query** — parse a date/range from the question, `events.list` against the same window, then format a short natural-language answer. LLM involvement here is about phrasing the answer, not about writing anything — no confirmation step needed since nothing is mutated.

Every step logs to `llm_calls` (fire-and-forget, must never block the user-facing response) — we want real data on fast-path-vs-LLM split and parse accuracy before tuning anything.

## API endpoints (Next.js route handlers, `web/src/app/api/*`)

- `GET /api/health` — liveness check. **Implemented.**
- `GET /api/auth/google/callback` — OAuth code exchange.
- `POST /api/parse` — text in, `{ intent, extraction, usedLLM }` out. Called before showing the confirm preview; does not write anything.
- `POST /api/events` — create an event (called on confirm).
- `GET /api/events?start=&end=` — list events in a range (query mode).

Everything else described above (auth, parse, events) is unimplemented scaffolding as of this spec — see `web/src/app/api/health/route.ts` for the only real route so far.

## Acceptance criteria for "v1 done"

- A user can install the unpacked extension, click "Connect Google Calendar," complete OAuth, and see a connected state in the popup.
- Typing "doctor's appointment at 9am tomorrow" shows a confirm preview with the correct date/time, and clicking confirm creates a real event on that Google account's primary calendar.
- Typing "do I have plans Saturday?" returns an answer that matches what's actually on the calendar.
- A wrong parse can be corrected before confirming (edit title/time in the preview) rather than only accept/reject.
- `llm_calls` has rows for both fast-path and LLM-fallback calls, so we can tell after a few days of use what fraction of inputs need the LLM at all.

## Open questions (revisit with real usage data, not now)

- Exact default event duration when none is stated (currently 30 min — arbitrary).
- How strict the fast-path regex should be before falling back to Claude — needs telemetry to tune, not a guess.
- Rate limiting / abuse prevention on `/api/parse` once it's exposed beyond just the extension's own users.
- Confirm-before-write is universal in v1; the `confirm_before_write` settings flag exists in the schema but has no UI to change it yet — revisit once parse accuracy is measured.
