import { getConfig } from "./config";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  // Lets the settings page list the user's actual calendars to pick from
  // instead of asking for a raw calendar ID — deliberately the read-only,
  // list-only scope (not the broader `calendar`/`calendar.calendarlist`
  // scopes, which also grant calendar management), consistent with
  // SPEC.md's minimal-scope approach.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "openid",
  "email",
  // Non-sensitive scope, only used for the account avatar in the panel
  // header — Google's userinfo endpoint doesn't return `picture` without it.
  "profile",
].join(" ");

export async function getSessionToken(): Promise<string | null> {
  const { sessionToken } = await chrome.storage.local.get("sessionToken");
  return typeof sessionToken === "string" ? sessionToken : null;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(["sessionToken", "email", "pictureUrl"]);
}

// Drives Google's consent screen via chrome.identity, then hands the
// resulting authorization code to our backend, which exchanges it
// server-side (the client secret never touches the extension) and returns
// a session token scoped to our own API.
export async function connectGoogle(): Promise<{ email: string; pictureUrl?: string }> {
  const config = await getConfig();
  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.googleClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });
  if (!resultUrl) throw new Error("Sign-in was cancelled");

  const code = new URL(resultUrl).searchParams.get("code");
  if (!code) throw new Error("Google did not return an authorization code");

  const res = await fetch(`${config.apiBase}/api/auth/google/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      redirectUri,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Sign-in failed (${res.status})`);
  }
  const data = (await res.json()) as { sessionToken: string; email: string; pictureUrl?: string };
  await chrome.storage.local.set({
    sessionToken: data.sessionToken,
    email: data.email,
    pictureUrl: data.pictureUrl,
  });
  return { email: data.email, pictureUrl: data.pictureUrl };
}
