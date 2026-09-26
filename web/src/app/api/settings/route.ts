import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { requireUser } from "@/lib/require-user";

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function serialize(row: typeof settings.$inferSelect) {
  return {
    timezone: row.timezone,
    defaultEventDurationMin: row.defaultEventDurationMin,
    defaultCalendarId: row.defaultCalendarId,
    emailAutoApply: row.emailAutoApply,
    extensionAutoApply: row.extensionAutoApply,
  };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const [row] = await db.select().from(settings).where(eq(settings.userId, auth.userId)).limit(1);
  if (!row) return Response.json({ error: "Settings not found" }, { status: 404 });
  return Response.json(serialize(row));
}

export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if ("unauthorized" in auth) return auth.unauthorized;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const update: Partial<{
    timezone: string;
    defaultEventDurationMin: number;
    defaultCalendarId: string;
    emailAutoApply: boolean;
    extensionAutoApply: boolean;
  }> = {};

  if (typeof body.timezone === "string" && body.timezone.trim()) {
    if (!isValidTimezone(body.timezone.trim())) {
      return Response.json({ error: "Unrecognized timezone" }, { status: 400 });
    }
    update.timezone = body.timezone.trim();
  }
  if (typeof body.defaultEventDurationMin === "number" && body.defaultEventDurationMin > 0) {
    update.defaultEventDurationMin = Math.round(body.defaultEventDurationMin);
  }
  if (typeof body.defaultCalendarId === "string" && body.defaultCalendarId.trim()) {
    update.defaultCalendarId = body.defaultCalendarId.trim();
  }

  if (typeof body.emailAutoApply === "boolean") update.emailAutoApply = body.emailAutoApply;
  if (typeof body.extensionAutoApply === "boolean") update.extensionAutoApply = body.extensionAutoApply;

  if (Object.keys(update).length === 0) {
    return Response.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await db.update(settings).set(update).where(eq(settings.userId, auth.userId));

  const [row] = await db.select().from(settings).where(eq(settings.userId, auth.userId)).limit(1);
  if (!row) return Response.json({ error: "Settings not found" }, { status: 404 });
  return Response.json(serialize(row));
}
