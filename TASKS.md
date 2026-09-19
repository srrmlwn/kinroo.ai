# v1 build tasks

Tracks implementation against `SPEC.md`. All code-side tasks are done; the last mile is manual (`SETUP.md`) and hasn't been run yet.

## Backend (`web/`)
- [x] Drizzle schema + config: `users`, `oauth_tokens`, `settings`, `llm_calls`
- [x] Token encryption helper (AES-256-GCM) for `oauth_tokens`
- [x] Session token helper (JWT sign/verify via `jose`)
- [x] `POST /api/auth/google/exchange` — code → tokens → user upsert → session JWT
- [x] Google Calendar client (`lib/google-calendar.ts`): refresh access token, `insertEvents`, `listEvents`
- [x] Parsing pipeline (`lib/parse.ts`): fast-path (chrono-node) + Claude fallback, shared by text/image/pdf
- [x] `POST /api/parse` — text or multipart image/pdf → `{ intent, candidates, answer?, usedLLM, inputType }`
- [x] `POST /api/events` — array of candidates → Calendar inserts (per-candidate ok/error)
- [x] `GET /api/events` — range read (used internally by query path, exposed for reuse)
- [x] `llm_calls` telemetry logging (fire-and-forget) wired into the parse path

## Extension (`extension/`)
- [x] Manifest: `identity` permission, updated host permissions
- [x] Auth: "Connect Google Calendar" via `chrome.identity.launchWebAuthFlow`, store session token
- [x] Popup: compose input (text) + file input/paste (image/pdf)
- [x] Popup: confirm list UI (editable rows, accept/deselect, bulk write)
- [x] Popup: query answer display
- [x] Popup: connected/disconnected state handling, basic error states

## Verification
- [x] `npm run typecheck` / `npm run build` clean across both workspaces
- [x] Unit tests for the fast path (`chrono-node` heuristics) and the deterministic query-answer formatter — the only pure, credential-free logic in the pipeline (`npm run test`, 21 tests)
- [ ] Manual walkthrough with real credentials — **not done yet**, see `SETUP.md`. Nothing in this repo has touched a real Google Calendar, a real database, or a real Claude API call.

## Explicitly not in this pass
- Family/multi-account, email ingest, WhatsApp, page-scan, proactive notifications — per `SPEC.md`.
