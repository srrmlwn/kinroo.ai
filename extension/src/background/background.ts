import { connectGoogle } from "../auth";
import { parseText } from "../api";
import { annotateConflicts } from "../conflicts";
import type { EditableAction } from "../types";

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
//   all when the context menu is clicked, so the parse has to happen here
//   and hand its result to the panel via the same `draft` storage key the
//   panel already restores from (see persistDraft in panel.ts) — opening
//   the panel after a click picks the result up automatically.
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

function setBadge(text: string, color?: string): void {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// Called after the draft (confirming/answer/notice) is already written to
// storage, never before — the panel only reads that draft once, at
// startup, so opening it first would risk showing a stale or empty state
// while the parse is still in flight.
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

  setBadge("…", "#9AA0A6");

  parseText(selection)
    .then(async (result) => {
      if (result.intent === "query") {
        await chrome.storage.local.set({
          draft: { kind: "answer", text: result.answer ?? "Nothing found.", events: result.queryEvents },
        });
      } else if (result.actions.length > 0) {
        // A single match is safe to default-select (matches the panel's
        // "accept all" UX for a lone create); multiple ambiguous
        // update/delete matches default unchecked so the user picks the
        // right one once they open the panel.
        const editable: EditableAction[] = result.actions.map((action) => ({
          action,
          selected: action.type === "create" || result.actions.length === 1,
        }));
        const actions = await annotateConflicts(editable);
        await chrome.storage.local.set({ draft: { kind: "confirming", actions } });
      } else {
        await chrome.storage.local.set({
          draft: { kind: "notice", text: "Couldn't find an event or question in that selection." },
        });
      }
      openSidePanelForTab(tab);
    })
    .catch(async (err) => {
      // Covers "not signed in" and network/parse failures alike — surfaced
      // in the panel now instead of a badge glyph nobody was watching for.
      await chrome.storage.local.set({
        draft: {
          kind: "notice",
          text: err instanceof Error ? err.message : "Something went wrong scanning that selection.",
        },
      });
      openSidePanelForTab(tab);
    })
    .finally(() => {
      setBadge("");
    });
});
