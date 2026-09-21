import { db } from "@/lib/db";
import { waitlistSignups } from "@/lib/db/schema";

// Basic RFC 5322-ish check — good enough to catch typos, not a full
// validator. Real confirmation would need actually sending an email, which
// this doesn't do.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email || !EMAIL_RE.test(email)) {
    return Response.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  // A duplicate signup is a success from the visitor's side, not an error —
  // avoid leaking "you already signed up" as a distinct response.
  await db.insert(waitlistSignups).values({ email }).onConflictDoNothing();

  return Response.json({ ok: true });
}
