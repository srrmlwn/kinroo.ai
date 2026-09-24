import { SignJWT, jwtVerify } from "jose";

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("90d")
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// One-shot, short-lived token the extension exchanges for a browser session
// cookie so the web settings page can authenticate without its own hosted
// login flow. The distinct `purpose` claim keeps it from being usable as a
// bearer session token even within its short window.
export async function createHandoffToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: "settings-handoff" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(getSecret());
}

export async function verifyHandoffToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.purpose !== "settings-handoff") return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

const SESSION_COOKIE = "session";
// Not `Authorization` — Vercel's edge network intercepts/consumes that
// header for its own deployment-protection checks even on domains meant to
// be exempt from it, so a custom bearer token in `Authorization` never
// reaches the route handler. Confirmed by logging incoming header names in
// production: the header the extension sent was simply absent server-side.
const SESSION_HEADER = "x-kinroo-session";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Extracts and verifies the session from a request — a bearer token in a
// custom header (the extension) or a `session` cookie (the web settings
// page). Returns the authenticated userId, or null if missing/invalid.
export async function getUserId(request: Request): Promise<string | null> {
  const header = request.headers.get(SESSION_HEADER);
  if (header) return verifySessionToken(header);
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) return verifySessionToken(cookie);
  return null;
}

export { SESSION_COOKIE, SESSION_HEADER };
