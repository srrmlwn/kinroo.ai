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
7. Web settings page (`/settings`) — timezone, default event duration, and calendar are editable outside the extension. The calendar field is a real picker over the user's actual Google calendars (`GET /api/settings/calendars`, filtered to ones they can write to) rather than a raw ID field — this needed a second, read-only OAuth scope (see Auth flow below), so an account connected before that scope existed falls back to a plain text field with a prompt to reconnect. Since there's no hosted web login, the extension's popup mints a short-lived handoff token that the settings page exchanges for a session cookie (`api/auth/handoff`) rather than the app growing a second OAuth flow.
8. Email ingest (`add@<domain>`) — a SendGrid Inbound Parse webhook runs an emailed request through the same parse pipeline as the extension. Confirm-before-write still applies with no popup available, so email uses reply-to-confirm instead: kinroo replies asking "add this? reply YES/NO," and only writes once that reply comes back. v1 queues one action per inbound email (the best/first match); an email that would produce several ambiguous or multi-candidate results only confirms the first — see `api/email/inbound`.

**Explicitly out of scope** (do not build, but see "Family-readiness notes" below for the conventions that keep these open):
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
Chrome extension (Manifest V3)                    SendGrid Inbound Parse
  popup — compose box + confirm-preview UI          (add@<domain>, confirm+<id>@<domain>)
  background service worker — holds session token           │
        │                                                    ▼
        ▼                                          POST /api/email/inbound
Next.js app (web/, deployed to Vercel)  ◄───────────────────┘
  route handlers = the entire backend API
  minimal pages = /settings (session-cookie auth via a handoff token from the extension)
        │
        ├──► Google Calendar API (events.insert/patch/delete, events.list) — the data
        ├──► Claude API — LLM fallback parsing (text, and always for image/PDF input)
        ├──► SendGrid Mail Send API — outbound reply-to-confirm emails
        └──► Postgres (Neon) — thin: users, oauth tokens, settings, email identities,
             a small pending-email-actions confirm queue, LLM telemetry only
```

No separate server process. No events table. Email ingest is just another route handler calling the same `parseInput`/`google-calendar.ts` functions the extension uses — not a new service. WhatsApp/SMS, when it arrives, follows the same shape.

## Data model (v1)

Only what's needed to authenticate a user, remember their preferences, and (as of email ingest) hold a small confirm-queue. No events, no family members — Google Calendar stays the only event store.

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

email_identities   -- address -> user_id lookup for the email channel; see Family-readiness notes
  address             text pk   -- lowercased
  user_id             uuid fk -> users.id
  created_at          timestamptz

pending_email_actions   -- reply-to-confirm queue for email ingest; nothing here is ever a source of truth for events
  id                  uuid pk
  user_id             uuid fk -> users.id
  action              jsonb       -- an EventAction (create/update/delete), same shape the extension confirms
  status              text default 'pending'   -- 'pending' | 'confirmed' | 'canceled' | 'expired'
  from_address        text
  created_at          timestamptz
  expires_at          timestamptz

llm_calls   -- telemetry, cheap to add now, valuable before any architecture decisions later
  id                  uuid pk
  user_id             uuid fk -> users.id
  channel             text        -- 'extension-compose', 'extension-query', 'email', ...
  input_type          text        -- 'text' | 'image' | 'pdf'
  used_llm            boolean     -- false = fast-path regex handled it alone (text only; image/pdf always true)
  model               text nullable
  intent              text        -- 'create' | 'query' | 'update' | 'delete' | 'unknown'
  candidate_count     int default 1   -- actions produced by this call; >1 for flyers/schedules or ambiguous edit/cancel matches
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
- Email identity resolves through `email_identities` (`address -> user_id`), not a column on `users` — seeded from the account's own Google email at OAuth time, so multiple addresses (and later, multiple people) can register against a shared context without restructuring. The same convention holds for phone/WhatsApp when that channel arrives.
- Application code takes `userId`/`calendarId` as explicit parameters everywhere — no global "current user" singleton.

## Auth flow

**Implemented.** No hosted login page — the extension drives Google's consent screen directly via `chrome.identity.launchWebAuthFlow`, and the backend does the token exchange.

1. Extension popup, unauthenticated state: "Connect Google Calendar" opens Google's OAuth consent screen via `chrome.identity.launchWebAuthFlow`, with `redirect_uri = chrome.identity.getRedirectURL()` (a `https://<extension-id>.chromiumapp.org/` URL, which must be registered as an authorized redirect URI on the Google Cloud OAuth client — see `SETUP.md`).
2. Scopes requested: `calendar.events` (read/write events), `calendar.calendarlist.readonly` (lets the settings page list the user's calendars for the picker — deliberately not the broader `calendar`/`calendar.calendarlist` scopes, which also grant calendar management), plus `openid email` (needed to identify the user via Google's userinfo endpoint — still narrower than requesting `profile`/full calendar access).
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
- `POST /api/auth/handoff` — bearer-authed; mints a short-lived, purpose-scoped JWT for the extension's "Settings" link to hand off to the web app.
- `GET /api/auth/handoff?token=` — verifies that token, sets an HttpOnly `session` cookie, and redirects to `/settings`.
- `GET/PATCH /api/settings` — reads/updates `timezone`, `default_event_duration_min`, `default_calendar_id` for the authenticated user (cookie or bearer). `confirm_before_write` is read-only.
- `GET /api/settings/calendars` — the user's Google calendars they can write to, for the settings page's calendar picker. 403 `{ error: "insufficient_scope" }` if their stored token predates the `calendar.calendarlist.readonly` scope.
- `POST /api/email/inbound` — SendGrid Inbound Parse webhook (`multipart/form-data`; guarded by a `?key=` shared secret, not a signature). The claimed sender must pass SPF or DKIM per SendGrid's own verdict fields — the shared secret only proves the request came from SendGrid, not that the "From" header is real, so a failing sender is dropped silently rather than trusted. A new submission to `add@<domain>` runs the same parse pipeline as `/api/parse` and, if it produces an action, emails back a reply-to-confirm request; a reply to `confirm+<id>@<domain>` applies or cancels that pending action based on a yes/no read of the reply body.

`/api/settings` and the extension-facing routes accept either `Authorization: Bearer <session token>` or the `session` cookie set by the handoff flow. `/api/health`, `/api/auth/google/exchange`, and `/api/email/inbound` (which authenticates the sender by resolved email identity instead) take neither.

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
- Clicking "Settings" in the popup opens `/settings` already signed in (no separate login), and changing the timezone there is reflected the next time the extension resolves a relative date.
- Emailing `add@<domain>` a plain-English event gets a reply asking to confirm; replying "yes" creates the real event, and nothing is written if there's no reply or the reply is "no" (email confirm-before-write, exercised as unit tests on the parsing helpers since the full loop needs a live domain — see SETUP.md §10).
- `llm_calls` has rows for both fast-path and LLM-fallback calls across all input types, so we can tell after a few days of use what fraction of inputs need the LLM, and how much volume is text vs. image/PDF.

## Open questions (revisit with real usage data, not now)

- Exact default event duration when none is stated (currently 30 min — arbitrary).
- How strict the fast-path regex should be before falling back to Claude — needs telemetry to tune, not a guess.
- Rate limiting / abuse prevention on `/api/parse` once it's exposed beyond just the extension's own users.
- Max image/PDF size and page count `/api/parse` accepts, and what the popup shows while a larger file is processing (image/PDF calls will be slower than text).
- Confirm-before-write is universal in v1; the `confirm_before_write` settings flag exists in the schema but has no UI to change it yet — revisit once parse accuracy is measured.
