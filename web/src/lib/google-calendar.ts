import { eq } from "drizzle-orm";
import { db } from "./db";
import { oauthTokens } from "./db/schema";
import { encrypt, decrypt } from "./crypto";

export interface EventCandidate {
  title: string;
  start: string; // ISO 8601 datetime
  end: string; // ISO 8601 datetime
  timezone?: string;
  location?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
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
        start: { dateTime: candidate.start, timeZone: candidate.timezone },
        end: { dateTime: candidate.end, timeZone: candidate.timezone },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Calendar insert failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    id: string;
    summary?: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    location?: string;
  };
  return {
    id: data.id,
    title: data.summary ?? candidate.title,
    start: data.start.dateTime ?? data.start.date ?? candidate.start,
    end: data.end.dateTime ?? data.end.date ?? candidate.end,
    location: data.location,
  };
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
