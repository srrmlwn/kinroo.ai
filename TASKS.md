# v1 build tasks

Tracks implementation against `SPEC.md`. All code-side tasks are done, including the follow-on features below. The last mile is manual verification with real credentials (`SETUP.md`) — done once, locally; not yet deployed anywhere.

## Backend (`web/`)
- [x] Drizzle schema + config: `users`, `oauth_tokens`, `settings`, `llm_calls`, `email_identities`, `pending_email_actions`
- [x] Token encryption helper (AES-256-GCM) for `oauth_tokens`
- [x] Session token helper (JWT sign/verify via `jose`)
- [x] `POST /api/auth/google/exchange` — code → tokens → user upsert → session JWT
- [x] Google Calendar client (`lib/google-calendar.ts`): refresh access token, `insertEvent`/`updateEvent`/`deleteEvent`/`listEvents`/`listCalendars`
- [x] Parsing pipeline (`lib/parse.ts`): fast-path (chrono-node) + Claude fallback, shared by text/image/pdf, with intent classification (create/query/update/delete/unknown)
- [x] `POST /api/parse` — text or multipart image/pdf → `{ intent, actions, answer?, usedLLM, inputType }`
- [x] `POST /api/events` — array of `EventAction` (create/update/delete) → Calendar writes (per-action ok/error)
- [x] `GET /api/events` — range read (query answers, edit/cancel search, conflict check)
- [x] Edit/cancel: keyword search over a Claude-inferred date window (`lib/match-events.ts`) to find the event(s) an update/delete request refers to
- [x] Recurring events: RRULE (+ EXDATE for stated exceptions) passed through to `events.insert`
- [x] Fast-path timezone fix: `Intl.DateTimeFormat`-based offset resolution, since chrono-node doesn't understand IANA zone names
- [x] Search-range / query-range hardening: RFC3339 validation before hitting Google's API, omit-if-no-hint guidance for Claude's search window
- [x] Settings page backend: `GET/PATCH /api/settings`, `GET /api/settings/calendars` (real calendar picker, 403 fallback for pre-scope-expansion tokens), `POST/GET /api/auth/handoff`
- [x] Email ingest: `POST /api/email/inbound` (SendGrid Inbound Parse), reply-to-confirm flow via `pending_email_actions`, SPF/DKIM sender verification before trusting a "From" address
- [x] `llm_calls` telemetry logging (fire-and-forget) wired into the parse path

## Extension (`extension/`)
- [x] Manifest: `identity`/`contextMenus`/`scripting`/`activeTab` permissions, host permissions, icons (16/32/48/128)
- [x] Auth: "Connect Google Calendar" via `chrome.identity.launchWebAuthFlow`, store session token, scopes incl. `calendar.calendarlist.readonly`
- [x] Popup: compose input (text) + file input/paste (image/pdf)
- [x] Popup: confirm list UI (editable rows, accept/deselect, bulk write) covering create/update/delete rows
- [x] Popup: query answer display
- [x] Popup: "Detect events on this page" button — runs the page's full text through the pipeline without prefilling the compose box (replaced the earlier noisy auto-scan-into-textbox behavior)
- [x] Popup: conflict detection — flags overlapping existing events on create rows before confirm, rechecked on edit
- [x] Popup: connected/disconnected state handling, basic error states
- [x] Branding: icon (calendar + spark mark), applied across manifest/popup and the web landing page

## Web landing page (`web/`)
- [x] Redesigned marketing page (`web/src/app/page.tsx`) reflecting the full feature set (compose, ask, edit/cancel, recurring, conflicts, page-detect)
- [x] Shared logo/icon design across extension icons, `web/src/app/icon.svg`, and the landing page

## Verification
- [x] `npm run typecheck` / `npm run build` clean across both workspaces
- [x] Unit tests for the fast path (chrono-node heuristics, timezone handling), the deterministic query-answer formatter, and the email-inbound pure parsing helpers (`npm run test`)
- [x] Manual walkthrough with real credentials, local dev only — connect, compose-create, query, edit/cancel, recurring, conflict detection all verified against a real Google account (see `SETUP.md`)
- [ ] Manual walkthrough of email ingest end-to-end (needs a real domain + public deployment — see `SETUP.md` §10)
- [ ] Production deployment walkthrough — not yet deployed anywhere (see "Next up" below)

## Explicitly not in this pass
- Family/multi-account, WhatsApp, proactive notifications, per-occurrence recurring edits — per `SPEC.md`.

## Next up: deployment
- [ ] Deploy `web/` to Vercel (no project exists yet as of this writing)
- [ ] Point `kinroo.ai` at Vercel and reconfigure the extension/OAuth client for the production URL
- [ ] Move secrets into Vercel's env config
- [ ] Verify email ingest end-to-end once there's a public HTTPS URL for the SendGrid webhook
