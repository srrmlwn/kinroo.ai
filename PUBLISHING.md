# Publishing to the Chrome Web Store

Everything needed to submit the extension is documented here — copy-paste-ready
listing content, the permission justifications the dashboard requires, and the
OAuth follow-up that publishing triggers. Nothing in this doc can be done by
Claude: it all requires your own Google/Chrome Web Store accounts, so treat
this as the checklist to work through yourself.

## Prerequisites

- [ ] A Google Account to use as the Web Store developer account (can be the
      same one you use for kinroo's Google Cloud project, or a separate one —
      separate is more common if you'd rather not mix a personal account with
      a published product).
- [ ] $5 one-time registration fee ([Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → pay via Google Payments).
- [ ] `https://kinroo.ai/privacy` live in production (added in this PR — confirm it loads before submitting).
- [ ] Use `kinroo.ai@gmail.com` as the contact address on the OAuth consent screen's support/developer contact fields, matching the privacy policy.

## 1. Package the extension

```bash
npm run build --workspace=extension   # or your usual one-off build
cd extension/dist
zip -r ../kinroo-extension.zip .
```

Upload `extension/kinroo-extension.zip` in the dashboard — not the `dist/`
folder directly, not the repo root.

## 2. Create the listing

**Chrome Web Store Developer Dashboard → New Item → upload the zip.**

| Field | Value |
|---|---|
| Name | kinroo.ai |
| Summary (132 char max) | Turn plain English into Google Calendar events — type it, paste a screenshot, or scan the page you're on. |
| Category | Productivity |
| Language | English |

**Detailed description** (paste as-is, edit freely):

```
kinroo turns plain English into real Google Calendar events.

Type "doctor's appointment at 9am tomorrow" and confirm — it's on your
calendar. Paste a screenshot of an invite or upload a photo of a flyer, and
kinroo pulls out the date, time, and title for you to review. Ask "what's on
Saturday?" and get a real answer read from your own calendar.

WHAT IT DOES
• Compose in plain English — kinroo parses the date, time, and title
• Paste or upload a screenshot, photo, or PDF — one event or twenty, in one shot
• Scan the page you're on for an event (an invite, a listing, a booking page)
• Ask questions about your schedule and get a direct answer
• Edit or cancel existing events by describing them in plain English
• Recurring events — "every Monday at 9am for 8 weeks" becomes one series
• Conflict detection — flags anything that overlaps before you confirm

TRUST, BY DESIGN
kinroo never writes to your calendar without showing you first. Every
create, edit, and cancellation is a confirm-before-write action — no
exceptions. kinroo also doesn't keep its own copy of your events; Google
Calendar is the only place your schedule lives.

WHAT IT NEEDS ACCESS TO
kinroo asks only for calendar event access (to create/edit/delete events you
confirm) and read-only access to your calendar list (so you can pick which
calendar it uses in settings). It never asks for Gmail, Drive, or Contacts
access.

Full privacy policy: https://kinroo.ai/privacy
```

**Graphics** (all can be captured from a real running side panel — see
`SETUP.md` for how the landing page's demo clips were made, if you want stills
from that same pipeline rather than manual screenshots):

| Asset | Size | Required? |
|---|---|---|
| Store icon | 128×128 PNG | Required — already have it: `extension/icons/icon128.png` |
| Screenshot | 1280×800 or 640×800, up to 5 | At least 1 required |
| Small promo tile | 440×280 | Optional but recommended — shown in search results |
| Marquee promo tile | 1400×560 | Optional — only used if Google features the extension |

Good screenshot candidates: the compose view with a confirm card open, the
upcoming-events strip, and the flyer-scan confirm list — the same three
moments captured in the website's demo clips.

## 3. Privacy practices tab

The dashboard requires a data-usage disclosure separate from your privacy
policy text. Answers based on what the code actually does:

| Question | Answer |
|---|---|
| Single purpose description | "Turns plain-English text, screenshots, and page content into Google Calendar events, and answers questions about the user's schedule." |
| Does this item collect or use personal data? | Yes |
| Personal/sensitive data collected | Personal communications (calendar event content), Authentication information (Google account email) |
| Is data sold to third parties? | No |
| Is data used for purposes unrelated to the item's core functionality? | No |
| Is data used to determine creditworthiness or for lending? | No |
| Privacy policy URL | `https://kinroo.ai/privacy` |

## 4. Permission justifications

The dashboard asks you to justify every permission in `manifest.json`. Use these:

| Permission | Justification |
|---|---|
| `storage` | Stores the signed-in user's session token and email locally, so they stay signed in between sessions. |
| `identity` | Drives Google's OAuth consent screen (`chrome.identity.launchWebAuthFlow`) so the user can connect their Google Calendar. |
| `contextMenus` | Adds a right-click "Add selection to kinroo.ai" menu item so the user can turn selected text into a calendar event without opening the panel first. |
| `scripting` | Reads the current tab's selected text or visible text, only when the user opens the panel or clicks "Scan page" — used to prefill the compose box or extract event details from the page. |
| `activeTab` | Grants the above script access only to the tab the user is actively interacting with, for that one action — no standing access to browsing history or arbitrary sites. |
| `sidePanel` | Renders the extension's UI as a Chrome side panel instead of a popup, so it survives tab switches and can be resized. |
| Host permission: `https://kinroo.ai/*`, `https://www.kinroo.ai/*` | The extension's own backend API (parsing, calendar writes, auth) — self-hosted, not a third party. |

## 5. Submit

Submit for review. Typical review time for a new item is a few hours to a
few days. You'll get an email when it's approved (or rejected with a reason —
address it and resubmit).

## 6. After the listing is approved: the OAuth follow-up

Publishing to the Web Store assigns the extension a **new, permanent
extension ID** — different from your local unpacked one. This has two
consequences:

1. **New redirect URI.** Go to Google Cloud Console → APIs & Services →
   Credentials → your OAuth client → Authorized redirect URIs → add
   `https://<published-extension-id>.chromiumapp.org/` (find the ID on the
   item's Web Store dashboard page). Keep the old one too, if you still want
   local unpacked installs to work.
2. **Config**: `extension/config.json`'s `apiBase` doesn't need to change —
   it's already `https://kinroo.ai` for a production build. Only the redirect
   URI is tied to the extension ID.

## 7. Moving past 100 users: Google's OAuth verification

While your OAuth consent screen is in **Testing** mode (the current state —
see `SETUP.md` §2), only the test users you've explicitly added can sign in,
regardless of how many people install the extension from the Web Store. To
let anyone sign in, you have to move the consent screen to **In production**,
which requires Google's app verification because `calendar.events` and
`calendar.calendarlist.readonly` are classified as **sensitive** (not
**restricted**) scopes — this needs verification, but not the annual
third-party security assessment restricted scopes require.

What Google will ask for (**do this only once you're ready to open up beyond
your own test users** — no need to hold up the Web Store submission on it):

- [ ] App homepage URL: `https://kinroo.ai`
- [ ] Privacy policy URL: `https://kinroo.ai/privacy`
- [ ] Authorized domain: `kinroo.ai`
- [ ] A short screen recording of the OAuth consent flow and how each
      requested scope is used in the product (a video of connecting Google
      Calendar, composing an event, and confirming it — the same real,
      non-mocked capture approach used for the landing page's demo clips
      would work well here; ask if you want help producing it once you're at
      this step)
- [ ] Written justification for each scope (reuse the "What we access on
      your Google Account" section of `web/src/app/privacy/page.tsx`)

Google's stated turnaround for sensitive-scope verification is roughly 1–6
weeks. Budget for that separately from the Web Store listing review, which is
much faster.

## 8. Once it's live

- [ ] Update the "Connect Google Calendar" / hero CTA area of
      `web/src/app/page.tsx` to link to the Chrome Web Store listing URL
      instead of (or alongside) the waitlist form.
- [ ] Update `TASKS.md` to check off the Web Store submission.
