import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

// AES-256-GCM for oauth_tokens at rest. Key must be a base64-encoded 32-byte
// value — generate with `openssl rand -base64 32`.
function getKey(): Buffer {
  const b64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!b64) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

// Output layout: base64(iv [12 bytes] || authTag [16 bytes] || ciphertext)
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decrypt(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
