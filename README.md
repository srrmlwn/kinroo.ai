# kinroo.ai

Natural language on top of Google Calendar. Type "doctor's appointment at 9am tomorrow" into a Chrome extension and get a real event on your Google Calendar — no calendar rebuilt, no separate event store.

See [`SPEC.md`](./SPEC.md) for the full v1 spec and [`CLAUDE.md`](./CLAUDE.md) for repo layout, conventions, and commands.

## Status

Early scaffolding — see "Current state" in `CLAUDE.md`.

## Quick start

```bash
npm install
npm run dev:web         # backend, localhost:3000
npm run dev:extension   # watches and rebuilds extension/dist/
```

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → `extension/dist/`.

## License

MIT — see `LICENSE`.
