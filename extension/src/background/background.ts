// Scaffold only — will own auth-token storage/refresh once
// the OAuth flow (SPEC.md §Auth flow) is implemented.
chrome.runtime.onInstalled.addListener(() => {
  console.log("kinroo.ai extension installed");
});
