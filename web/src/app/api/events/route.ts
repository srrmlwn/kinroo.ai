import { requireUser } from "@/lib/require-user";
import { getUserSettings } from "@/lib/user-settings";
import { applyEventAction, listEvents, type EventAction } from "@/lib/google-calendar";

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

  const { defaultCalendarId } = await getUserSettings(auth.userId);

  const results = await Promise.allSettled(
    actions.map((action) => applyEventAction(auth.userId, defaultCalendarId, action)),
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

  const { defaultCalendarId } = await getUserSettings(auth.userId);
  const events = await listEvents(auth.userId, defaultCalendarId, start, end);
  return Response.json({ events });
}
