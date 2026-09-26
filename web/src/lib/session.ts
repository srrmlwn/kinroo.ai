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
    // Session tokens never carry a `purpose`. Every other token signed with
    // this secret does (the settings handoff, email undo links), and must
    // not work as a bearer session — an undo link sits in an email for 30
    // days, and full API access is far more than it's meant to grant.
    if (payload.purpose !== undefined) return null;
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

// Signed into the undo links in an auto-apply summary email (lib/email-batch.ts).
// Holding the link is the authorization — it only ever goes to the user's
// own inbox — so it's scoped as tightly as possible: one batch, one item (or
// "all"), one user, its own `purpose`, and an expiry.
export interface UndoLinkClaims {
  userId: string;
  batchId: string;
  item: number | "all";
}

const UNDO_LINK_PURPOSE = "email-undo";

export async function createUndoLinkToken(claims: UndoLinkClaims): Promise<string> {
  return new SignJWT({ sub: claims.userId, purpose: UNDO_LINK_PURPOSE, b: claims.batchId, i: claims.item })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
}

export async function verifyUndoLinkToken(token: string): Promise<UndoLinkClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.purpose !== UNDO_LINK_PURPOSE) return null;
    if (typeof payload.sub !== "string" || typeof payload.b !== "string") return null;
    const item = payload.i;
    if (item !== "all" && !(typeof item === "number" && Number.isInteger(item) && item > 0)) return null;
    return { userId: payload.sub, batchId: payload.b, item };
  } catch {
    return null;
  }
}
