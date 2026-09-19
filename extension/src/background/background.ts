// Auth and API calls live in the popup (src/auth.ts, src/api.ts) since MV3
// popups have the same chrome.* API access as the background worker and
// there's no cross-view state to coordinate yet. This stays minimal until
// a feature needs it (e.g. a badge update after a background sync).
chrome.runtime.onInstalled.addListener(() => {
  console.log("kinroo.ai extension installed");
});
