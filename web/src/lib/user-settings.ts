import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings as settingsTable } from "./db/schema";

export interface UserSettings {
  timezone: string;
  defaultEventDurationMin: number;
  defaultCalendarId: string;
}

// Shared by every read path that needs a user's calendar/parsing
// preferences (parse.ts, api/events, api/email/inbound) — previously
// duplicated per caller.
export async function getUserSettings(userId: string): Promise<UserSettings> {
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId))
    .limit(1);
  return {
    timezone: row?.timezone ?? "UTC",
    defaultEventDurationMin: row?.defaultEventDurationMin ?? 30,
    defaultCalendarId: row?.defaultCalendarId ?? "primary",
  };
}
