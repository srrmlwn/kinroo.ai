import { connectGoogle } from "../auth";

// API calls live in the popup (src/api.ts) — no cross-view state to
// coordinate there. Google sign-in runs here instead: chrome.identity's
// consent window steals focus, and Chrome closes the popup on focus loss,
// which would kill an in-popup fetch/storage.set before it finished. The
// background worker isn't affected by the popup's lifecycle.
chrome.runtime.onInstalled.addListener(() => {
  console.log("kinroo.ai extension installed");
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
