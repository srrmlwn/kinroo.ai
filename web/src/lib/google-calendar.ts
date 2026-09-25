import { eq } from "drizzle-orm";
import { db } from "./db";
import { oauthTokens } from "./db/schema";
import { encrypt, decrypt } from "./crypto";

// title/start/end are "" when the source never stated them (a pasted
// snippet with no date, a page with no event name) — the confirm step makes
// the user fill them in, and applyEventAction refuses to write without them.
export interface EventCandidate {
  title: string;
  start: string; // ISO 8601 datetime, or "" if unknown
  end: string; // ISO 8601 datetime, or "" if unknown
  timezone?: string;
  location?: string;
  // iCalendar lines (RFC 5545), e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10", "EXDATE:20261126T180000Z"].
  // Passed straight through to the Calendar API's `recurrence` field.
  recurrence?: string[];
}

// All-day events come back from listEvents as a bare date ("2026-09-27"),
// and the extension's Undo round-trips them straight back through
// createEvent/updateEvent (re-creating a canceled event, restoring an
// edited one) — sending a bare date as `dateTime` is rejected by Google, so
// it has to go back out as `date`.
function toEventTime(value: string, timeZone?: string): { date: string } | { dateTime: string; timeZone?: string } {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value, timeZone };
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
}

// A confirm-list row is one of three write intents against an existing or
// new event. "update"/"delete" carry `original` (the event as found by
// listEvents/findMatchingEvents) purely for display in the confirm UI —
// the write itself only needs eventId.
export type EventAction =
  | { type: "create"; candidate: EventCandidate }
  | { type: "update"; eventId: string; original: CalendarEvent; candidate: EventCandidate }
  | { type: "delete"; eventId: string; original: CalendarEvent };

// Distinguishes "the stored token doesn't have this scope yet" (403) from
// any other Calendar API failure, so callers (api/settings/calendars) can
// tell an existing user to reconnect rather than showing a generic error.
export class CalendarApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

interface GoogleEventResource {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
}

function toCalendarEvent(data: GoogleEventResource, fallback: EventCandidate): CalendarEvent {
  return {
    id: data.id,
    title: data.summary ?? fallback.title,
    start: data.start.dateTime ?? data.start.date ?? fallback.start,
    end: data.end.dateTime ?? data.end.date ?? fallback.end,
    location: data.location,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Returns a valid access token for the user, refreshing against Google
// if the stored one has expired. Refresh tokens from Google don't expire
// under normal use, so we don't handle re-consent here — a revoked/expired
// refresh token surfaces as a thrown error from the Calendar API call.
async function getAccessToken(userId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.userId, userId))
    .limit(1);
  if (!row) throw new Error(`No stored Google tokens for user ${userId}`);

  if (row.expiresAt.getTime() > Date.now() + 60_000) {
    return decrypt(row.accessTokenEncrypted);
  }

  const refreshToken = decrypt(row.refreshTokenEncrypted);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };

  await db
    .update(oauthTokens)
    .set({
      accessTokenEncrypted: encrypt(data.access_token),
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    })
    .where(eq(oauthTokens.userId, userId));

  return data.access_token;
}

export async function insertEvent(
  userId: string,
  calendarId: string,
  candidate: EventCandidate,
): Promise<CalendarEvent> {
  const accessToken = await getAccessToken(userId);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: candidate.title,
        location: candidate.location,
        start: toEventTime(candidate.start, candidate.timezone),
        end: toEventTime(candidate.end, candidate.timezone),
        recurrence: candidate.recurrence,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Calendar insert failed: ${res.status} ${await res.text()}`);
  }
  return toCalendarEvent((await res.json()) as GoogleEventResource, candidate);
}

export async function updateEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  candidate: EventCandidate,
): Promise<CalendarEvent> {
  const accessToken = await getAccessToken(userId);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: candidate.title,
        location: candidate.location,
        start: toEventTime(candidate.start, candidate.timezone),
        end: toEventTime(candidate.end, candidate.timezone),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Calendar update failed: ${res.status} ${await res.text()}`);
  }
  return toCalendarEvent((await res.json()) as GoogleEventResource, candidate);
}

export async function deleteEvent(
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const accessToken = await getAccessToken(userId);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  // Google returns 410 Gone for an event that's already deleted — treat
  // that as success rather than surfacing an error for a no-op.
  if (!res.ok && res.status !== 410) {
    throw new Error(`Calendar delete failed: ${res.status} ${await res.text()}`);
  }
}

// Shared create/update/delete dispatch — used by the extension's confirm
// list (api/events/route.ts) and by the email reply-to-confirm flow
// (api/email/inbound/route.ts), so both channels write through the same
// code path once something is confirmed.
export function isCandidateComplete(candidate: EventCandidate): boolean {
  return (
    candidate.title.trim() !== "" &&
    !Number.isNaN(Date.parse(candidate.start)) &&
    !Number.isNaN(Date.parse(candidate.end))
  );
}

export async function applyEventAction(
  userId: string,
  calendarId: string,
  action: EventAction,
): Promise<CalendarEvent | void> {
  if (action.type !== "delete" && !isCandidateComplete(action.candidate)) {
    throw new Error("Event needs a title, start, and end before it can be saved");
  }
  if (action.type === "create") return insertEvent(userId, calendarId, action.candidate);
  if (action.type === "update") return updateEvent(userId, calendarId, action.eventId, action.candidate);
  return deleteEvent(userId, calendarId, action.eventId);
}

export async function listEvents(
  userId: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const accessToken = await getAccessToken(userId);
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Calendar list failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    items: Array<{
      id: string;
      summary?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      location?: string;
    }>;
  };
  return data.items.map((item) => ({
    id: item.id,
    title: item.summary ?? "(untitled)",
    start: item.start.dateTime ?? item.start.date ?? "",
    end: item.end.dateTime ?? item.end.date ?? "",
    location: item.location,
  }));
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary: boolean;
}

// Requires the calendar.calendarlist.readonly scope, which only accounts
// that reconnected after it was added will have — see api/settings/calendars
// for the fallback when an older token doesn't have it yet.
export async function listCalendars(userId: string): Promise<CalendarListEntry[]> {
  const accessToken = await getAccessToken(userId);
  const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new CalendarApiError(`Calendar list-of-calendars failed: ${res.status} ${await res.text()}`, res.status);
  }
  const data = (await res.json()) as {
    items: Array<{ id: string; summary?: string; primary?: boolean; accessRole: string }>;
  };
  // Only calendars kinroo can actually write to are useful as a default —
  // a read-only subscribed calendar would fail every insert/update/delete.
  return data.items
    .filter((item) => item.accessRole === "owner" || item.accessRole === "writer")
    .map((item) => ({ id: item.id, summary: item.summary ?? item.id, primary: item.primary ?? false }));
}
