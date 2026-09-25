# v1 build tasks

Tracks implementation against `SPEC.md`. All code-side tasks are done, including the follow-on features below. It's been manually verified locally with real credentials (`SETUP.md`), and now end-to-end in production too: connect, compose-create, and upcoming events all verified working against the real `https://kinroo.ai` deployment with a real Google account. Email ingest still needs a live run (see below).

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
- [x] Panel: "Scan page" action — runs the page's full text through the pipeline without prefilling the compose box (replaced the earlier noisy auto-scan-into-textbox behavior). Fixed a real bug: it silently failed most of the time because `activeTab` is granted per-tab at the moment the extension is invoked, but the whole point of a persistent side panel is surviving tab switches — so the active tab often wasn't the one `activeTab` covered anymore. Now falls back to requesting a standing per-origin permission (`optional_host_permissions`) when the plain attempt comes back empty.
- [x] Right-click "Add selection to kinroo.ai" pastes the selection into the compose box and auto-opens the side panel (`chrome.sidePanel.open`), instead of auto-parsing immediately or leaving a badge glyph on the toolbar icon that was easy to miss entirely — matches every other input path (typing, a pasted image, a scanned page) in requiring an explicit Send before it hits the parser
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
- [x] Production deployment walkthrough — connect, compose-create, and upcoming events verified working against the real `https://kinroo.ai` deployment and a real Google account. Session auth had to move off the standard `Authorization` header to a custom `x-kinroo-session` one — Vercel's Deployment Protection intercepts `Authorization` even on domains meant to be exempt from it.

## Explicitly not in this pass
- Family/multi-account, WhatsApp, proactive notifications, per-occurrence recurring edits — per `SPEC.md`.

## Next up: deployment
- [x] Deploy `web/` to Vercel (project `kinroo-ai`, root directory `web`)
- [x] Point `kinroo.ai` at Vercel (apex + `www`, both verified) — DNS is on Namecheap
- [x] GitHub Actions CI (typecheck/build/test) on every PR and push to `main`, `enable_pr_auto_merge` used going forward
- [x] Add production env vars in the Vercel dashboard (`DATABASE_URL` on a separate prod Neon branch, `GOOGLE_CLIENT_ID`/`SECRET`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`) — `SENDGRID_API_KEY`/`EMAIL_INGEST_*` still pending, only needed for email ingest
- [x] Branch protection on `main` requiring the CI `build` check (so auto-merge actually gates on green CI instead of merging immediately)
- [ ] Verify email ingest end-to-end once there's a public HTTPS URL for the SendGrid webhook

## Future ideas (not started)
- [ ] Widen `lib/fast-path.ts`'s regex/chrono-node coverage using real query patterns — the misses already surfaced in `web/eval/query/` (`npm run eval:query`, see its `cases.ts`) and in `llm_calls` production telemetry (e.g. recurring phrasing like "every Monday", common edit/cancel phrasings). The fast path is the real lever for cutting Claude fallback rate, since it's the only call site with zero cost/latency — every request currently hits exactly one Claude call (`extractWithClaude` in `lib/claude.ts`, already on the cheapest current model) only when the fast path can't confidently handle it, and it skips recurring phrasing entirely today.
