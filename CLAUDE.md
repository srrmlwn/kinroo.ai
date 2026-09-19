# CLAUDE.md — kinroo.ai

Read `SPEC.md` first — it has the actual architecture, data model, and rationale. This file is conventions and day-to-day mechanics.

## What this project is

kinroo.ai turns plain English into Google Calendar events and answers. Google Calendar is the only data store — this app never owns event data. v1 is a single Chrome extension (compose-to-create, then query), single Google account per user. See `SPEC.md` for full scope and what's deliberately deferred (family, email, WhatsApp, page-scan).

## Repo layout

```
web/         Next.js app (App Router) — the entire backend, deployed to Vercel.
             Route handlers under web/src/app/api/* ARE the API; no separate server.
extension/   Chrome extension (Manifest V3), bundled with esbuild.
SPEC.md      Product + technical spec — read before adding any feature.
```

This is an npm workspaces monorepo (`workspaces: ["web", "extension"]` in the root `package.json`). Run `npm install` from the repo root, not inside `web/` or `extension/`.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Next.js route handlers (TypeScript), deployed to Vercel |
| Database | Postgres via Neon — thin schema (users, oauth tokens, settings, LLM telemetry), no events table |
| Auth | Google OAuth (`calendar.events` scope only) |
| LLM | Claude API — fallback parser when regex/heuristics can't confidently extract an event |
| Extension | Manifest V3, TypeScript, esbuild |

## Commands

```bash
npm install                        # from repo root — installs both workspaces

npm run dev:web                    # Next.js dev server (localhost:3000)
npm run dev:extension              # esbuild watch mode -> extension/dist/

npm run build                      # builds both workspaces
npm run typecheck                  # type-checks both workspaces
```

To load the extension in Chrome during development: `chrome://extensions` → enable Developer mode → "Load unpacked" → select `extension/dist/`. Rebuild (`npm run dev:extension` watches automatically) then click the reload icon on the extension card — Chrome doesn't hot-reload extensions.

## Conventions

- **TypeScript everywhere**, strict mode.
- **No separate backend framework.** If a route handler needs shared logic, put it in `web/src/lib/`, not a new server.
- **Never hardcode `'primary'` as a calendar ID inline** — always read it from settings (see `SPEC.md` → Family-readiness notes). This is the one convention that's cheap now and expensive to retrofit.
- **Confirm before every write.** No code path creates or modifies a Google Calendar event without a user-facing confirmation step, regardless of parser confidence. This is a product trust decision, not a suggestion.
- **Explicit `userId`/`calendarId` parameters** through application code — no global "current user" singleton.
- Log every parse (fast-path or LLM) to `llm_calls`, fire-and-forget — telemetry must never add latency to the user-facing response.

## Environment variables

See `web/.env.example`. Required for local dev: `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`.

## Prior art (not in this repo)

An earlier prototype, `simple-family-calendar`, explored a different bet — its own Postgres event store with one-way Google Calendar import, family-first data model, browser extension deprioritized in favor of WhatsApp/email. It's a useful reference for operational patterns (Google OAuth setup, SendGrid domain auth, a grep-based pre-commit security scan) but its architecture is deliberately not this one — see `SPEC.md` → "Why this shape" if that divergence needs re-explaining later.

## Current state

Scaffolding only. The only real route handler is `GET /api/health`. Everything else in `SPEC.md`'s API section is unbuilt. Don't assume auth, parsing, or event creation work yet — check `web/src/app/api/` before claiming a feature exists.
