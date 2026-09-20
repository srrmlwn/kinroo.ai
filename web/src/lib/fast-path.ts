import * as chrono from "chrono-node";
import type { EventCandidate } from "./google-calendar";

const QUESTION_PATTERN =
  /^(do i|am i|what'?s|whats|when'?s|is there|are there|how many|any (plans|events)|what do i have)\b/i;

export function looksLikeQuery(text: string): boolean {
  return QUESTION_PATTERN.test(text.trim());
}

const RECURRENCE_PATTERN =
  /\b(every|each|daily|weekly|biweekly|monthly|repeats?|recurring)\b/i;

// The regex fast path has no way to encode a recurrence rule, so text that
// smells like a repeating event skips it entirely and always falls back to
// Claude — otherwise "every Monday at 6pm" would silently create a single
// one-off event with no series attached.
export function looksLikeRecurring(text: string): boolean {
  return RECURRENCE_PATTERN.test(text);
}

const MODIFICATION_PATTERN =
  /\b(cancel|delete|remove|reschedule|postpone|move|push back|rename|change|update)\b/i;

// The create fast path (chrono + leftover-text-as-title) would happily
// misread "move my dentist appointment to 4pm" as a new "move my dentist
// appointment" event at 4pm. Text that looks like an edit/cancel request
// skips both fast paths and always goes to Claude, which classifies the
// intent as "update"/"delete" and searches existing events instead.
export function looksLikeModification(text: string): boolean {
  return MODIFICATION_PATTERN.test(text);
}

// chrono-node's `timezone` option only understands abbreviations ("PST",
// "CDT") or a raw minute offset — an IANA zone name like
// "America/Los_Angeles" silently fails to match and resolves to no
// timezone at all, so every parsed time comes back as if it had zero UTC
// offset. This converts an IANA name into the numeric offset chrono
// expects (sign convention: minutes to add to UTC to get local time, e.g.
// Pacific Daylight Time = -420), computed for the given instant so it's
// DST-aware.
function timezoneOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(raw);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
}

// Regex/date-library fast path for the common "<title> at <time>" phrasing.
// Returns null when it isn't confident, so the caller falls back to Claude
// rather than writing a bad title.
export function fastPathExtractCreate(
  text: string,
  referenceDate: Date,
  timezone: string,
  defaultDurationMin: number,
): EventCandidate | null {
  const offsetMinutes = timezoneOffsetMinutes(timezone, referenceDate);
  const results = chrono.parse(text, { instant: referenceDate, timezone: offsetMinutes }, { forwardDate: true });
  if (results.length === 0) return null;

  const result = results[0];
  const start = result.start.date();
  const end = result.end
    ? result.end.date()
    : new Date(start.getTime() + defaultDurationMin * 60_000);

  const before = text.slice(0, result.index).trim();
  const after = text.slice(result.index + result.text.length).trim();
  let title = [before, after].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  title = title.replace(/^(at|on|for|,|-)\s+/i, "").replace(/\s+(at|on)$/i, "");

  if (title.length < 2) return null;

  return { title, start: start.toISOString(), end: end.toISOString() };
}

// Start/end of the calendar day (in `timeZone`) that `instant` falls on,
// as correct UTC instants — deliberately not `Date.prototype.setHours`,
// which truncates in the *server's* local timezone rather than the one
// asked for, silently wrong for a "what's on Saturday" query as soon as
// the server's system timezone differs from the user's (true for any real
// deployment, since a query's timezone comes from settings.timezone, not
// the machine running the code).
function zonedDayBoundaries(instant: Date, timeZone: string): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);

  // A UTC instant carrying the target day's wall-clock numbers — not the
  // real boundary yet, just a reference point close enough in time to look
  // up the correct (DST-aware) offset for that day.
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0, 0);
  const offsetMinutes = timezoneOffsetMinutes(timeZone, new Date(wallClockAsUtc));

  const start = new Date(wallClockAsUtc - offsetMinutes * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60_000 - 1);
  return { start, end };
}

// Deterministic date-range resolution for simple queries ("Saturday",
// "tomorrow", "next week"). Returns null when chrono can't find a
// reference, so the caller falls back to Claude for phrasing like
// "this weekend" or "the week after next".
export function fastPathQueryRange(
  text: string,
  referenceDate: Date,
  timezone: string,
): { start: Date; end: Date } | null {
  const offsetMinutes = timezoneOffsetMinutes(timezone, referenceDate);
  const results = chrono.parse(text, { instant: referenceDate, timezone: offsetMinutes }, { forwardDate: true });
  if (results.length === 0) return null;

  const result = results[0];
  const start = result.start.date();

  if (result.start.isCertain("hour")) {
    const end = result.end ? result.end.date() : new Date(start.getTime() + 60 * 60_000);
    return { start, end };
  }

  const { start: dayStart, end: dayEnd } = zonedDayBoundaries(start, timezone);
  return { start: dayStart, end: dayEnd };
}
