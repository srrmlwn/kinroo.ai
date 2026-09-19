import { connectGoogle } from "../auth";
import { parseText } from "../api";

const CONTEXT_MENU_ID = "kinroo-add-selection";

// API calls otherwise live in the popup (src/api.ts) — no cross-view state to
// coordinate there. Two things run here instead, because both need to
// survive the popup's lifecycle rather than depend on it:
//
// - Google sign-in: chrome.identity's consent window steals focus, and
//   Chrome closes the popup on focus loss, which would kill an in-popup
//   fetch/storage.set before it finished.
// - The right-click "add selection" flow below: there's no popup open at
//   all when the context menu is clicked, so the parse has to happen here
//   and hand its result to the popup via the same `draft` storage key the
//   popup already restores from (see persistDraft in popup.ts) — reopening
//   the popup after a click picks the result up automatically.
chrome.runtime.onInstalled.addListener(() => {
  console.log("kinroo.ai extension installed");
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Add selection to kinroo.ai",
    contexts: ["selection"],
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "connect-google") return undefined;

  connectGoogle()
    .then((result) => sendResponse({ ok: true, email: result.email }))
    .catch((err) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : "Sign-in failed" }),
    );
  return true; // keep the message channel open for the async response
});

function setBadge(text: string, color?: string): void {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const selection = info.selectionText?.trim();
  if (!selection) return;

  setBadge("…", "#9AA0A6");

  parseText(selection)
    .then(async (result) => {
      if (result.intent === "query") {
        await chrome.storage.local.set({
          draft: { kind: "answer", text: result.answer ?? "Nothing found." },
        });
        setBadge("✓", "#1E8E3E");
      } else if (result.intent === "create" && result.candidates.length > 0) {
        await chrome.storage.local.set({
          draft: {
            kind: "confirming",
            candidates: result.candidates.map((c) => ({ ...c, selected: true })),
          },
        });
        setBadge("✓", "#1E8E3E");
      } else {
        // Nothing recognizable in the selection — no popup is open to show
        // an inline notice, so just clear the "working" badge.
        setBadge("");
      }
    })
    .catch(() => {
      // Covers "not signed in" (opening the popup manually still shows the
      // normal connect screen) and network/parse failures alike — there's
      // no popup surface to report the specific error to here.
      setBadge("");
    })
    .finally(() => {
      setTimeout(() => setBadge(""), 8000);
    });
});
