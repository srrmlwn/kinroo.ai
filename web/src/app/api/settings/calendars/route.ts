import { requireUser } from "@/lib/require-user";
import { listCalendars, CalendarApiError } from "@/lib/google-calendar";

// Backs the settings page's calendar picker. A stored token from before the
// calendar.calendarlist.readonly scope was added won't have it — that
// surfaces as a 403 from Google, which we pass through distinctly
// (error: "insufficient_scope") so the client can prompt to reconnect
// instead of showing a generic failure.
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  try {
    const calendars = await listCalendars(auth.userId);
    return Response.json({ calendars });
  } catch (err) {
    if (err instanceof CalendarApiError && err.status === 403) {
      return Response.json({ error: "insufficient_scope" }, { status: 403 });
    }
    console.error("[settings/calendars] failed", err);
    return Response.json({ error: "Could not load calendars" }, { status: 502 });
  }
}
