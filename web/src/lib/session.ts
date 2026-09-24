import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";

// TEMP DIAGNOSTICS (this whole block down to the `====` marker) — remove
// once the "session expired immediately after sign-in" bug is resolved.
// None of this logs the secret or the raw token itself: `fingerprint`
// produces a short, one-way hash so two log lines can be compared for
// equality without exposing the value being fingerprinted.
function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function debugEnvInfo() {
  return {
    vercelEnv: process.env.VERCEL_ENV,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
    region: process.env.VERCEL_REGION,
    url: process.env.VERCEL_URL,
  };
}
// ====

function getSecretString(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return secret;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getSecretString());
}

export async function createSessionToken(userId: string): Promise<string> {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("90d")
    .sign(getSecret());
  console.log("[debug-sign]", {
    userId,
    tokenFingerprint: fingerprint(token),
    tokenLen: token.length,
    secretFingerprint: fingerprint(getSecretString()),
    secretLen: getSecretString().length,
    ...debugEnvInfo(),
  });
  return token;
}

export async function verifySessionToken(
  token: string,
): Promise<string | null> {
  console.log("[debug-verify-attempt]", {
    tokenFingerprint: fingerprint(token),
    tokenLen: token.length,
    secretFingerprint: fingerprint(getSecretString()),
    secretLen: getSecretString().length,
    ...debugEnvInfo(),
  });
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    console.log("[debug-verify-ok]", { sub, tokenFingerprint: fingerprint(token) });
    return sub;
  } catch (err) {
    console.error("[debug-verify-fail]", {
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      tokenFingerprint: fingerprint(token),
      tokenLen: token.length,
      secretFingerprint: fingerprint(getSecretString()),
      secretLen: getSecretString().length,
      ...debugEnvInfo(),
    });
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
  const cookie = readCookie(request, SESSION_COOKIE);
  console.log("[debug-getuserid]", {
    url: request.url,
    method: request.method,
    hasAuthHeader: auth != null,
    authLen: auth?.length,
    startsWithBearer: auth?.startsWith("Bearer "),
    bearerTokenFingerprint: auth?.startsWith("Bearer ")
      ? fingerprint(auth.slice("Bearer ".length))
      : undefined,
    hasCookie: cookie != null,
    cookieFingerprint: cookie ? fingerprint(cookie) : undefined,
    allHeaderNames: [...request.headers.keys()],
  });
  if (auth?.startsWith("Bearer ")) {
    return verifySessionToken(auth.slice("Bearer ".length));
  }
  if (cookie) return verifySessionToken(cookie);
  return null;
}

export { SESSION_COOKIE };
