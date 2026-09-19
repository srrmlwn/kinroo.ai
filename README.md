# kinroo.ai

Natural language on top of Google Calendar. Type "doctor's appointment at 9am tomorrow" into a Chrome extension and get a real event on your Google Calendar — no calendar rebuilt, no separate event store.

See [`SPEC.md`](./SPEC.md) for the full v1 spec and [`CLAUDE.md`](./CLAUDE.md) for repo layout, conventions, and commands.

## Status

v1 (compose + query, text/image/PDF input) is implemented — see "Current state" in `CLAUDE.md`. Not yet run against real credentials; **start with [`SETUP.md`](./SETUP.md)**, which walks through the Google Cloud, Neon, and Anthropic setup this needs before it does anything.

## Quick start

Full first-time setup (Google OAuth client, database, API keys) is in [`SETUP.md`](./SETUP.md) — do that first. Once configured:

```bash
npm install
npm run dev:web         # backend, localhost:3000
npm run dev:extension   # watches and rebuilds extension/dist/
```

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/dist/`.

## License

MIT — see `LICENSE`.
