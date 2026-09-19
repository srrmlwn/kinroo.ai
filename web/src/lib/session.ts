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

// Extracts and verifies the bearer session token from a request.
// Returns the authenticated userId, or null if missing/invalid.
export async function getUserId(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return verifySessionToken(auth.slice("Bearer ".length));
}
