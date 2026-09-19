# kinroo.ai — v1 Spec: Compose-to-Calendar

_Written: 2026-09-18_

## What kinroo.ai is

A natural-language interface layer on top of Google Calendar — not a calendar app. kinroo never owns event data; Google Calendar is the only source of truth. kinroo's job is turning plain English into Calendar API calls (and, later, turning Calendar data into plain English answers).

## v1 scope

**In scope:**
1. Chrome extension, compose mode — type free text, paste a screenshot, or upload an image/PDF (flyer, invite, itinerary) in the popup; get one or more Google Calendar events.
2. Chrome extension, query mode — ask a natural-language question about the calendar, get an answer.
3. Single Google account per user. Confirm-before-write on every create/update, including a bulk confirm list when one input yields multiple candidate events (e.g. a season schedule flyer).

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

Competitive research (2026-09-18) found plain-text compose and image/flyer parsing already shipped as *separate* tools — a 300K-user Chrome extension for text-only compose; several standalone screenshot/flyer-to-calendar apps (ScreenToCal, Herds, Image2Cal) — plus Google's own Gemini doing native create+query inside Calendar itself. None combine text input, image/attachment input, and query in one surface. That combination, not the underlying NLP capability (which is now widely available), is the actual differentiation — hence folding image/attachment input into v1 rather than deferring it.

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
        ├──► Claude API — LLM fallback parsing (text, and always for image/PDF input)
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
  input_type          text        -- 'text' | 'image' | 'pdf'
  used_llm            boolean     -- false = fast-path regex handled it alone (text only; image/pdf always true)
  model               text nullable
  intent              text        -- 'create' | 'query' | 'unknown'
  candidate_count     int default 1   -- events extracted in this call; >1 for flyers/schedules
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
input (text | image | pdf) ──► intent classification ──► extraction ──► confirm list ──► write/read
```

1. **Input** — text typed in the popup, or an image/PDF pasted (clipboard) or uploaded (file picker): a screenshot of an invite email, a photo of a flyer, an itinerary attachment.
2. **Intent classification** — text only: regex/heuristic first pass — does this look like a creation ("X at Y", "schedule...", a weekday/date + time) or a question ("do I have", "what's on", "am I free")? Ambiguous or low-confidence → Claude call classifies intent as part of the same request that does extraction. Image/PDF input skips straight to extraction — an uploaded file is never a query.
3. **Extraction (create)** — always returns an **array** of 0+ candidate events `{ title, start, end, timezone, location? }`. Plain text almost always yields exactly one candidate; an image of a multi-date flyer can yield many in a single call.
   - Fast path (text only): regex/date-library parsing (e.g. relative dates, "Xam/pm") for common single-event phrasings.
   - Fallback (text when the fast path can't confidently fill required fields; **always** for image/PDF): one Claude call with the raw text or an image/PDF content block, using a structured tool-call schema that returns an array.
   - Any candidate missing an explicit duration → default from `settings.default_event_duration_min`.
4. **Confirm** — popup shows every candidate as an editable row in one list, whether there's 1 or 20. User can accept all, edit any row inline, or deselect individual rows before writing. Single-event and bulk-flyer cases share this exact UI — no separate "bulk mode." Non-negotiable in v1 regardless of parser confidence.
5. **Write** — on confirm, `events.insert` for each accepted candidate, against `settings.default_calendar_id`.
6. **Query** — text only. Parse a date/range from the question, `events.list` against the same window, then format a short natural-language answer. LLM involvement here is about phrasing the answer, not about writing anything — no confirmation step needed since nothing is mutated.

Every step logs to `llm_calls` (fire-and-forget, must never block the user-facing response) — we want real data on fast-path-vs-LLM split, input-type mix, and parse accuracy before tuning anything.

## API endpoints (Next.js route handlers, `web/src/app/api/*`)

- `GET /api/health` — liveness check. **Implemented.**
- `GET /api/auth/google/callback` — OAuth code exchange.
- `POST /api/parse` — text, or an image/PDF (multipart), in; `{ intent, candidates: Extraction[], usedLLM, inputType }` out. Called before showing the confirm list; does not write anything.
- `POST /api/events` — create one or more events (accepts an array, so a multi-candidate flyer commits in one request on confirm).
- `GET /api/events?start=&end=` — list events in a range (query mode).

Everything else described above (auth, parse, events) is unimplemented scaffolding as of this spec — see `web/src/app/api/health/route.ts` for the only real route so far.

## Acceptance criteria for "v1 done"

- A user can install the unpacked extension, click "Connect Google Calendar," complete OAuth, and see a connected state in the popup.
- Typing "doctor's appointment at 9am tomorrow" shows a confirm preview with the correct date/time, and clicking confirm creates a real event on that Google account's primary calendar.
- Typing "do I have plans Saturday?" returns an answer that matches what's actually on the calendar.
- A wrong parse can be corrected before confirming (edit title/time in the preview) rather than only accept/reject.
- Pasting a screenshot of an event invite (e.g. a meeting confirmation email) produces a correct single-candidate confirm list.
- Uploading a photo of a multi-date flyer (e.g. a sports schedule) produces a multi-candidate confirm list, and accepting it creates all selected events in one action.
- `llm_calls` has rows for both fast-path and LLM-fallback calls across all input types, so we can tell after a few days of use what fraction of inputs need the LLM, and how much volume is text vs. image/PDF.

## Open questions (revisit with real usage data, not now)

- Exact default event duration when none is stated (currently 30 min — arbitrary).
- How strict the fast-path regex should be before falling back to Claude — needs telemetry to tune, not a guess.
- Rate limiting / abuse prevention on `/api/parse` once it's exposed beyond just the extension's own users.
- Max image/PDF size and page count `/api/parse` accepts, and what the popup shows while a larger file is processing (image/PDF calls will be slower than text).
- Confirm-before-write is universal in v1; the `confirm_before_write` settings flag exists in the schema but has no UI to change it yet — revisit once parse accuracy is measured.
