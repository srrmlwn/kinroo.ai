import * as chrono from "chrono-node";
import type { EventCandidate } from "./google-calendar";

// A question word or phrase at the start, or a trailing "?". The negative
// lookahead keeps pasted invite fields ("When: Sunday 3pm", "What: Maya's
// party") from reading as questions, and "do"/"did"/"will" only count with
// "I"/"we" after them so "Do laundry Saturday" is still a create.
const QUESTION_PATTERN =
  /^(?:(?:what|whats|what's|when|whens|when's|where|which|who|how)\b(?!\s*:)|(?:do|did|will|am|have|can) (?:i|we)\b|(?:is|are) (?:there|i|we)\b|any(?:thing)?\b|show me\b)/i;

export function looksLikeQuery(text: string): boolean {
  const trimmed = text.trim();
  return QUESTION_PATTERN.test(trimmed) || trimmed.endsWith("?");
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

const MAX_FAST_PATH_TITLE_WORDS = 8;

// A street address ("5680 24th Ave NW") or a state + ZIP ("WA 98107").
const ADDRESS_PATTERN =
  /\b\d{1,6}\s+(?:[\w.'-]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\b|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i;

// Everything left over after the date/time match becomes the title, which
// is only right for short typed phrases. Text copied off a web page or an
// email ("Event details Sunday, September 27 3:00PM Add to calendar Tumbles
// Ballard 5680 24th Ave NW ...") leaves a long run of headings, button
// labels, and an address — that needs Claude to pick apart, not a bigger
// regex, so the fast path bails instead.
function looksLikeShortTitle(title: string): boolean {
  return title.split(/\s+/).length <= MAX_FAST_PATH_TITLE_WORDS && !ADDRESS_PATTERN.test(title);
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
  let after = text.slice(result.index + result.text.length).trim();

  // A trailing "at <place>" (or "@ <place>") left over after the date/time
  // match is almost always a location ("dentist at 3pm at Main Street
  // Dental") rather than more of the title — chrono already claimed the
  // "at <time>" earlier in the string, so a second leading "at" here isn't
  // a time and shouldn't get glued onto the title like the rest of `after`.
  let location: string | undefined;
  const locationMatch = /^(?:at|@)\s+(.+)$/i.exec(after);
  if (locationMatch) {
    location = locationMatch[1].trim();
    after = "";
  }

  let title = [before, after].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  title = title.replace(/^(at|on|for|,|-)\s+/i, "").replace(/\s+(at|on)$/i, "");

  if (title.length < 2) return null;
  if (!looksLikeShortTitle(title)) return null;

  return {
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    ...(location ? { location } : {}),
  };
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

// Words that only ask "what's on my calendar then". Any other word — a
// name ("does Sasha have anything"), "free", "first", "next", "morning",
// "after" — means the question wants something picked out of that range
// rather than all of it, which needs Claude.
const LISTING_WORDS = new Set([
  "what", "whats", "what's", "do", "i", "we", "have", "has", "got", "any", "anything", "plans",
  "plan", "planned", "events", "event", "is", "are", "there", "on", "for", "going", "happening",
  "show", "me", "my", "our", "schedule", "calendar", "look", "looks", "like", "does", "the",
]);

function isPlainListingQuestion(textWithoutDate: string): boolean {
  const words = textWithoutDate
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.every((word) => LISTING_WORDS.has(word));
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
  if (!isPlainListingQuestion(text.slice(0, result.index) + " " + text.slice(result.index + result.text.length))) {
    return null;
  }
  const start = result.start.date();

  if (result.start.isCertain("hour")) {
    const end = result.end ? result.end.date() : new Date(start.getTime() + 60 * 60_000);
    return { start, end };
  }

  const { start: dayStart, end: dayEnd } = zonedDayBoundaries(start, timezone);
  // chrono resolves "this weekend" / "next weekend" to just the Saturday —
  // stretch it through Sunday so a weekend question sees both days.
  if (/\bweekend\b/i.test(text) && weekdayIn(start, timezone) === "Sat") {
    const { end: sundayEnd } = zonedDayBoundaries(new Date(dayEnd.getTime() + 1), timezone);
    return { start: dayStart, end: sundayEnd };
  }
  return { start: dayStart, end: dayEnd };
}

function weekdayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
}
