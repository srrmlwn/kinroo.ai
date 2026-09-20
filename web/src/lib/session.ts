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

// Extracts and verifies the session from a request — a bearer token (the
// extension) or a `session` cookie (the web settings page). Returns the
// authenticated userId, or null if missing/invalid.
export async function getUserId(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return verifySessionToken(auth.slice("Bearer ".length));
  }
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) return verifySessionToken(cookie);
  return null;
}

export { SESSION_COOKIE };
