# kinroo.ai — v1 Spec: Compose-to-Calendar

_Written: 2026-09-18_

## What kinroo.ai is

A natural-language interface layer on top of Google Calendar — not a calendar app. kinroo never owns event data; Google Calendar is the only source of truth. kinroo's job is turning plain English into Calendar API calls (and, later, turning Calendar data into plain English answers).

## v1 scope

**In scope:**
1. Chrome extension, compose mode — type free text, paste a screenshot, or upload an image/PDF (flyer, invite, itinerary) in the popup; get one or more Google Calendar events. If nothing's selected, the popup falls back to scanning the open page's visible text (`document.body.innerText`, truncated) rather than starting blank.
2. Chrome extension, query mode — ask a natural-language question about the calendar, get an answer.
3. Chrome extension, edit/cancel mode — "cancel my dentist appointment", "move my 3pm to 4pm" finds the matching existing event(s) by keyword search over a Claude-inferred date window and shows them in the same confirm list, tagged as an update or delete rather than a create.
4. Recurring events — a create request with repeating phrasing ("every Monday", "weekly for 8 weeks") carries an iCalendar RRULE through to `events.insert`.
5. Conflict detection — the confirm list flags when a create candidate overlaps something already on the calendar, checked against a single `events.list` call over the candidates' combined time range.
6. Single Google account per user. Confirm-before-write on every create/update/delete, including a bulk confirm list when one input yields multiple candidate events (e.g. a season schedule flyer) or multiple ambiguous matches for an edit/cancel request.

**Explicitly out of scope** (do not build, but see "Family-readiness notes" below for the conventions that keep these open):
- Email ingest (`add@kinroo.ai`) — phase 3.
- WhatsApp/SMS — phase 4.
- Family / multi-account / shared calendars.
- Auto-commit without confirmation (modeled as a settings flag, not built).
- Proactive notifications (morning briefing, conflict alerts) — conflict *detection* at confirm time is in scope (see above); unprompted notifications are not.
- Editing which occurrence of a recurring series to change (Google's "this event" / "this and following" / "all events" choice) — update/delete acts on the single event instance the search matched.

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

**Implemented.** No hosted login page — the extension drives Google's consent screen directly via `chrome.identity.launchWebAuthFlow`, and the backend does the token exchange.

1. Extension popup, unauthenticated state: "Connect Google Calendar" opens Google's OAuth consent screen via `chrome.identity.launchWebAuthFlow`, with `redirect_uri = chrome.identity.getRedirectURL()` (a `https://<extension-id>.chromiumapp.org/` URL, which must be registered as an authorized redirect URI on the Google Cloud OAuth client — see `SETUP.md`).
2. Scopes requested: `calendar.events`, plus `openid email` (needed to identify the user via Google's userinfo endpoint — narrower than requesting `profile`/full calendar access).
3. `launchWebAuthFlow` resolves with the redirect URL containing `?code=...`; the extension extracts the code and POSTs `{ code, redirectUri, timezone }` to `POST /api/auth/google/exchange`.
4. The backend exchanges the code for tokens (client secret never touches the extension), fetches the profile, upserts `users`/`oauth_tokens`/`settings` (seeding `settings.timezone` from the client-supplied `Intl` timezone rather than defaulting blindly to UTC), and returns a session JWT.
5. The extension stores the session JWT in `chrome.storage.local` and sends it as `Authorization: Bearer <token>` on every subsequent call. The backend verifies it, maps it to a user, and uses that user's stored (encrypted) Google refresh token to call the Calendar API server-side — the extension never sees the Google token directly.

## Core pipeline (shared shape, extension is the only caller in v1)

```
input (text | image | pdf) ──► intent classification ──► extraction ──► confirm list ──► write/read
```

1. **Input** — text typed in the popup (or prefilled from a page selection / full-page scan / right-click menu), or an image/PDF pasted (clipboard) or uploaded (file picker): a screenshot of an invite email, a photo of a flyer, an itinerary attachment.
2. **Intent classification** — text only: regex/heuristic first pass distinguishes a creation ("X at Y", "schedule...", a weekday/date + time), a question ("do I have", "what's on", "am I free"), or an edit/cancel request ("cancel...", "move...", "reschedule...", "rename..." — anything the modification heuristic catches skips the fast path entirely, since a naive regex parse would misread "move my dentist to 4pm" as a new event). Ambiguous or low-confidence text → one Claude call classifies intent (`create` | `query` | `update` | `delete` | `unknown`) as part of the same request that does extraction/search. Image/PDF input skips straight to extraction — an uploaded file is never a query or an edit request.
3. **Extraction (create)** — always returns an **array** of 0+ candidate events `{ title, start, end, timezone, location?, recurrence? }`. Plain text almost always yields exactly one candidate; an image of a multi-date flyer can yield many in a single call. A repeating-event phrase ("every Monday", "weekly for 8 weeks") sets `recurrence` to an RRULE and skips the fast path (which has no way to encode one).
   - Fast path (text only, create/query intents only): regex/date-library parsing (e.g. relative dates, "Xam/pm") for common single-event phrasings.
   - Fallback (text when the fast path can't confidently fill required fields, or the text looks like an edit/cancel/recurring request; **always** for image/PDF): one Claude call with the raw text or an image/PDF content block, using a structured tool-call schema.
   - Any candidate missing an explicit duration → default from `settings.default_event_duration_min`.
4. **Search (update/delete)** — for an edit/cancel request, Claude returns a short search phrase plus an inferred date window instead of a candidate; the backend runs `events.list` over that window and keyword-matches the phrase against event titles (`lib/match-events.ts`) to find the event(s) being referred to. No match → the popup reports it couldn't find one rather than falling back to guessing.
5. **Confirm** — popup shows every result as a row in one list — a create (editable title/start/end, tagged with any recurrence/conflict note), an update (original event shown for reference, editable new title/start/end), or a delete (original event shown, cancel-only, no editable fields) — whether there's 1 row or 20. User can accept all, edit any editable row inline, or deselect individual rows before writing. A single match defaults selected; multiple ambiguous update/delete matches default unselected so the user picks the right one. Non-negotiable regardless of parser confidence.
   - **Conflict detection**: for create rows, the popup fetches existing events across the rows' combined time range in one `events.list` call and flags any overlap inline, rechecked whenever a row's start/end is hand-edited.
6. **Write** — on confirm, each selected row applies as `events.insert` (create), `events.patch` (update), or `events.delete` (delete) against `settings.default_calendar_id`, returned as a per-row ok/error array (partial failure is visible, not all-or-nothing).
7. **Query** — text only. Parse a date/range from the question, `events.list` against the same window, then format a short natural-language answer. LLM involvement here is about phrasing the answer, not about writing anything — no confirmation step needed since nothing is mutated.

Every step logs to `llm_calls` (fire-and-forget, must never block the user-facing response) — we want real data on fast-path-vs-LLM split, input-type mix, and parse accuracy before tuning anything.

## API endpoints (Next.js route handlers, `web/src/app/api/*`)

All implemented as of this revision:

- `GET /api/health` — liveness check.
- `POST /api/auth/google/exchange` — OAuth code → session JWT (see Auth flow above).
- `GET /api/auth/me` — resolves the bearer session token to `{ email, name }`; lets the popup confirm connected state.
- `POST /api/parse` — text (JSON `{ text }`) or an image/PDF (`multipart/form-data`, field `file`) in; `{ intent, actions, answer?, usedLLM, inputType }` out, where `actions` is an array of `{ type: "create", candidate }` / `{ type: "update", eventId, original, candidate }` / `{ type: "delete", eventId, original }`. For `intent: "query"`, the backend already ran the Calendar read and `answer` is ready to display — no second request needed. Does not write anything.
- `POST /api/events` — `{ actions: EventAction[] }` in; applies each (`events.insert` / `events.patch` / `events.delete`) and returns a per-action ok/error array (partial failure is visible, not all-or-nothing).
- `GET /api/events?start=&end=` — range read, used internally by the query and update/delete search paths, and by the popup's conflict check.

All require `Authorization: Bearer <session token>` except `/api/health` and `/api/auth/google/exchange`.

## Acceptance criteria for "v1 done"

- A user can install the unpacked extension, click "Connect Google Calendar," complete OAuth, and see a connected state in the popup.
- Typing "doctor's appointment at 9am tomorrow" shows a confirm preview with the correct date/time, and clicking confirm creates a real event on that Google account's primary calendar.
- Typing "do I have plans Saturday?" returns an answer that matches what's actually on the calendar.
- A wrong parse can be corrected before confirming (edit title/time in the preview) rather than only accept/reject.
- Pasting a screenshot of an event invite (e.g. a meeting confirmation email) produces a correct single-candidate confirm list.
- Uploading a photo of a multi-date flyer (e.g. a sports schedule) produces a multi-candidate confirm list, and accepting it creates all selected events in one action.
- Typing "cancel my dentist appointment" finds the real event on the calendar and shows a cancel-confirmation row rather than creating a new "cancel my dentist appointment" event.
- Typing "team standup every Monday at 9am for 10 weeks" creates a single recurring series, not 10 separate events or one non-repeating event.
- Creating an event that overlaps something already on the calendar shows a conflict warning in the confirm list before the write happens.
- `llm_calls` has rows for both fast-path and LLM-fallback calls across all input types, so we can tell after a few days of use what fraction of inputs need the LLM, and how much volume is text vs. image/PDF.

## Open questions (revisit with real usage data, not now)

- Exact default event duration when none is stated (currently 30 min — arbitrary).
- How strict the fast-path regex should be before falling back to Claude — needs telemetry to tune, not a guess.
- Rate limiting / abuse prevention on `/api/parse` once it's exposed beyond just the extension's own users.
- Max image/PDF size and page count `/api/parse` accepts, and what the popup shows while a larger file is processing (image/PDF calls will be slower than text).
- Confirm-before-write is universal in v1; the `confirm_before_write` settings flag exists in the schema but has no UI to change it yet — revisit once parse accuracy is measured.
