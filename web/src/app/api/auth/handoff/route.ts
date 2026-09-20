import { requireUser } from "@/lib/require-user";
import { createHandoffToken, verifyHandoffToken, createSessionToken, SESSION_COOKIE } from "@/lib/session";

const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

// Called by the extension (bearer-authed) right before it opens the web
// settings page in a new tab, so that tab can authenticate without a
// separate hosted login flow. The returned token is short-lived and only
// good for the handoff below — it's a JWT, not a stored single-use code, so
// it could in principle be replayed within its ~2 minute window, but never
// grants more than "start a normal browser session as this user."
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const token = await createHandoffToken(auth.userId);
  return Response.json({ token });
}

// Opened directly in a browser tab (not fetched) — verifies the handoff
// token, sets a normal session cookie, and redirects into the settings
// page proper so the URL bar doesn't keep the token around.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const userId = token ? await verifyHandoffToken(token) : null;
  if (!userId) {
    return Response.json({ error: "Invalid or expired sign-in link" }, { status: 401 });
  }

  const sessionToken = await createSessionToken(userId);
  const isHttps = url.protocol === "https:";
  const cookie = [
    `${SESSION_COOKIE}=${sessionToken}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    ...(isHttps ? ["Secure"] : []),
  ].join("; ");

  return new Response(null, {
    status: 302,
    headers: { Location: "/settings", "Set-Cookie": cookie },
  });
}
