import * as chrono from "chrono-node";
import type { EventCandidate } from "./google-calendar";

const QUESTION_PATTERN =
  /^(do i|am i|what'?s|whats|when'?s|is there|are there|how many|any (plans|events)|what do i have)\b/i;

export function looksLikeQuery(text: string): boolean {
  return QUESTION_PATTERN.test(text.trim());
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
  const results = chrono.parse(text, { instant: referenceDate, timezone }, { forwardDate: true });
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

// Deterministic date-range resolution for simple queries ("Saturday",
// "tomorrow", "next week"). Returns null when chrono can't find a
// reference, so the caller falls back to Claude for phrasing like
// "this weekend" or "the week after next".
export function fastPathQueryRange(
  text: string,
  referenceDate: Date,
  timezone: string,
): { start: Date; end: Date } | null {
  const results = chrono.parse(text, { instant: referenceDate, timezone }, { forwardDate: true });
  if (results.length === 0) return null;

  const result = results[0];
  const start = result.start.date();

  if (result.start.isCertain("hour")) {
    const end = result.end ? result.end.date() : new Date(start.getTime() + 60 * 60_000);
    return { start, end };
  }

  const dayStart = new Date(start);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(start);
  dayEnd.setHours(23, 59, 59, 999);
  return { start: dayStart, end: dayEnd };
}
