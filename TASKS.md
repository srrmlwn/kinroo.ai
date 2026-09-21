# v1 build tasks

Tracks implementation against `SPEC.md`. All code-side tasks are done, including the follow-on features below. It's been manually verified once locally with real credentials (`SETUP.md`), and a Vercel project + domain now exist — but production env vars aren't set yet, so nothing has actually run at `https://kinroo.ai` end-to-end.

## Backend (`web/`)
- [x] Drizzle schema + config: `users`, `oauth_tokens`, `settings`, `llm_calls`, `email_identities`, `pending_email_actions`, `waitlist_signups`
- [x] `POST /api/waitlist` — pre-launch email capture for the landing page hero, no auth, duplicate-safe insert
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
- [x] Manifest: `identity`/`contextMenus`/`scripting`/`activeTab`/`sidePanel` permissions, host permissions, icons (16/32/48/128)
- [x] Auth: "Connect Google Calendar" via `chrome.identity.launchWebAuthFlow`, store session token, scopes incl. `calendar.calendarlist.readonly`
- [x] Panel (formerly an action popup, migrated to `chrome.sidePanel` — resizable, survives focus loss/tab switches): compose input (text) + file input/paste/drag-and-drop (image/pdf), auto-growing textarea, Cmd/Ctrl+Enter submit, example prompt chips
- [x] Panel: confirm list UI (editable rows, accept/deselect, bulk write) covering create/update/delete rows
- [x] Panel: query answer display
- [x] Panel: "Scan page" action — runs the page's full text through the pipeline without prefilling the compose box (replaced the earlier noisy auto-scan-into-textbox behavior)
- [x] Panel: conflict detection — flags overlapping existing events on create rows before confirm, rechecked on edit
- [x] Panel: connected/disconnected state handling, basic error states
- [x] Panel: upcoming-events strip (next 5, `GET /api/events`) as compact tiles — relative day labels + time badges — with an "Open Google Calendar" link
- [x] Panel: one-click Undo after a confirm, reusing `applyActions`/`POST /api/events` with the inverse action(s)
- [x] Panel: "command card" layout — attach/scan/send controls inside the compose toolbar instead of separate full-width buttons, account details (email, default calendar, sign out) behind an avatar dropdown instead of on-screen text, dark mode via `prefers-color-scheme`
- [x] Branding: icon (calendar + spark mark), applied across manifest/panel and the web landing page

## Web landing page (`web/`)
- [x] Redesigned marketing page (`web/src/app/page.tsx`) reflecting the full feature set (compose, ask, edit/cancel, recurring, conflicts, page-detect)
- [x] Shared logo/icon design across extension icons, `web/src/app/icon.svg`, and the landing page
- [x] Dark "command tool" redesign scoped to the landing page only (hero rewrite, input→output transformation chip, tactile 01/02/03 step visuals, 6 feature cards consolidated into 3 pillars, trust-badge footer)
- [x] Email waitlist form in the hero, wired to `POST /api/waitlist`
- [x] Tabbed demo showcase — 3 looping clips (Text Prompt / Flyer Scan / Page Detection) of the real side panel, all captured from the actual built extension (headless Chromium driving the genuine app code against stubbed API responses — including a real synthetic flyer image upload and a real second-tab page-scan — not mockups or an AI-generated video)

## Verification
- [x] `npm run typecheck` / `npm run build` clean across both workspaces
- [x] Unit tests for the fast path (chrono-node heuristics, timezone handling), the deterministic query-answer formatter, and the email-inbound pure parsing helpers (`npm run test`)
- [x] Manual walkthrough with real credentials, local dev only — connect, compose-create, query, edit/cancel, recurring, conflict detection all verified against a real Google account (see `SETUP.md`)
- [x] Side-panel migration spot-checked headlessly (Chromium `--load-extension`, real manifest/service worker, no console errors; ready/confirm views screenshotted in light and dark mode) — not a substitute for clicking through it in real Chrome, which still needs doing once at a desk
- [ ] Manual walkthrough of email ingest end-to-end (needs a real domain + public deployment — see `SETUP.md` §10)
- [ ] Production deployment walkthrough — CI/CD and the Vercel project exist now (see below); an actual signed-in run against `https://kinroo.ai` hasn't happened yet

## Explicitly not in this pass
- Family/multi-account, WhatsApp, proactive notifications, per-occurrence recurring edits — per `SPEC.md`.

## Next up: deployment
- [x] Deploy `web/` to Vercel (project `kinroo-ai`, root directory `web`)
- [x] Point `kinroo.ai` at Vercel (apex + `www`, both verified) — DNS is on Namecheap
- [x] GitHub Actions CI (typecheck/build/test) on every PR and push to `main`, `enable_pr_auto_merge` used going forward
- [ ] Add production env vars in the Vercel dashboard (`DATABASE_URL` on a separate prod Neon branch, `GOOGLE_CLIENT_ID`/`SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`)
- [ ] Branch protection on `main` requiring the CI `build` check (so auto-merge actually gates on green CI instead of merging immediately)
- [ ] Verify email ingest end-to-end once there's a public HTTPS URL for the SendGrid webhook
