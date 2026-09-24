import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireUser } from "@/lib/require-user";

// Lets the panel check "am I connected, and as whom" without decoding the
// JWT client-side or re-running OAuth.
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  return Response.json({ email: user.email, name: user.name, pictureUrl: user.pictureUrl });
}
