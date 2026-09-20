import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { requireUser } from "@/lib/require-user";
import { insertEvent, updateEvent, deleteEvent, listEvents, type EventAction } from "@/lib/google-calendar";

async function getCalendarId(userId: string): Promise<string> {
  const [row] = await db
    .select({ defaultCalendarId: settings.defaultCalendarId })
    .from(settings)
    .where(eq(settings.userId, userId))
    .limit(1);
  return row?.defaultCalendarId ?? "primary";
}

function applyAction(userId: string, calendarId: string, action: EventAction) {
  if (action.type === "create") return insertEvent(userId, calendarId, action.candidate);
  if (action.type === "update") return updateEvent(userId, calendarId, action.eventId, action.candidate);
  return deleteEvent(userId, calendarId, action.eventId);
}

// Applies one or more create/update/delete actions in a single request —
// the array shape lets a multi-candidate flyer, or several ambiguous
// matches for an edit/cancel request, commit together once the user
// confirms the list.
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const body = await request.json().catch(() => null);
  const actions = body?.actions as EventAction[] | undefined;
  if (!Array.isArray(actions) || actions.length === 0) {
    return Response.json({ error: "actions array is required" }, { status: 400 });
  }

  const calendarId = await getCalendarId(auth.userId);

  const results = await Promise.allSettled(
    actions.map((action) => applyAction(auth.userId, calendarId, action)),
  );

  const events = results.map((result, i) =>
    result.status === "fulfilled"
      ? { ok: true as const, action: actions[i].type, event: result.value ?? undefined }
      : { ok: false as const, action: actions[i].type, error: String(result.reason) },
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
