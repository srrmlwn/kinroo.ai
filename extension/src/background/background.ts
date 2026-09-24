import { connectGoogle } from "../auth";

const CONTEXT_MENU_ID = "kinroo-add-selection";

// API calls otherwise live in the panel (src/api.ts) — no cross-view state to
// coordinate there. Two things run here instead, because both need to
// survive independently of whether the panel is open:
//
// - Google sign-in: chrome.identity's consent window steals focus. The side
//   panel survives ordinary focus loss (unlike the old action popup, which
//   Chrome destroyed on any click elsewhere), but running the flow here
//   still means it isn't tied to the panel's document at all — a closed or
//   not-yet-opened panel doesn't block sign-in.
// - The right-click "add selection" flow below: there's no panel open at
//   all when the context menu is clicked, so the selection has to be handed
//   off via the same `draft` storage key the panel already restores from
//   (see persistDraft in panel.ts) — opening the panel after a click picks
//   it up automatically.
chrome.runtime.onInstalled.addListener(() => {
  console.log("kinroo.ai extension installed");
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Add selection to kinroo.ai",
    contexts: ["selection"],
  });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[kinroo] failed to set side panel behavior", err));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "connect-google") return undefined;

  connectGoogle()
    .then((result) => sendResponse({ ok: true, email: result.email, pictureUrl: result.pictureUrl }))
    .catch((err) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : "Sign-in failed" }),
    );
  return true; // keep the message channel open for the async response
});

function openSidePanelForTab(tab: chrome.tabs.Tab | undefined): void {
  if (tab?.windowId === undefined) return;
  chrome.sidePanel
    .open({ windowId: tab.windowId })
    .catch((err) => console.error("[kinroo] failed to open side panel", err));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const selection = info.selectionText?.trim();
  if (!selection) return;

  // Must happen synchronously, before any await — chrome.sidePanel.open()
  // requires a live user gesture.
  openSidePanelForTab(tab);

  // Pastes the selection into the compose box rather than parsing it
  // immediately — every other input path (typing, a pasted image, a
  // scanned page) requires an explicit Send before it hits the parser, so
  // a selection shouldn't skip that review/edit step either. Reuses the
  // panel's own "ready" draft shape (see persistDraft in panel.ts); `source`
  // marks it as written by this flow rather than the panel's own
  // persistDraft — the panel's storage.onChanged listener uses that to
  // apply it live if the panel is already open (init() alone only covers a
  // panel that was closed and just opened fresh).
  chrome.storage.local
    .set({ draft: { kind: "ready", inputText: selection, source: "selection" } })
    .catch((err) => console.error("[kinroo] failed to write selection draft", err));
});
