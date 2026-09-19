import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { requireUser } from "@/lib/require-user";
import { insertEvent, listEvents, type EventCandidate } from "@/lib/google-calendar";

async function getCalendarId(userId: string): Promise<string> {
  const [row] = await db
    .select({ defaultCalendarId: settings.defaultCalendarId })
    .from(settings)
    .where(eq(settings.userId, userId))
    .limit(1);
  return row?.defaultCalendarId ?? "primary";
}

// Creates one or more events — the array shape lets a multi-candidate flyer
// commit in a single request once the user confirms the list.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const body = await request.json().catch(() => null);
  const candidates = body?.candidates as EventCandidate[] | undefined;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return Response.json({ error: "candidates array is required" }, { status: 400 });
  }

  const calendarId = await getCalendarId(auth.userId);

  const results = await Promise.allSettled(
    candidates.map((candidate) => insertEvent(auth.userId, calendarId, candidate)),
  );

  const events = results.map((result, i) =>
    result.status === "fulfilled"
      ? { ok: true as const, event: result.value }
      : { ok: false as const, candidate: candidates[i], error: String(result.reason) },
  );

  const allFailed = events.every((e) => !e.ok);
  return Response.json({ events }, { status: allFailed ? 502 : 200 });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) {
    return Response.json({ error: "start and end query params are required" }, { status: 400 });
  }

  const calendarId = await getCalendarId(auth.userId);
  const events = await listEvents(auth.userId, calendarId, start, end);
  return Response.json({ events });
}
