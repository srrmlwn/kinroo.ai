import type { CalendarEvent } from "./google-calendar";

const STOPWORDS = new Set([
  "my",
  "the",
  "a",
  "an",
  "with",
  "at",
  "on",
  "for",
  "to",
  "and",
  "of",
  "appointment",
  "meeting",
  "event",
]);

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Simple keyword-overlap scoring — no fuzzy matching, no external
// dependency. Good enough to disambiguate "cancel the dentist thing" among
// a search window's worth of events; ambiguous or zero-score results are
// left for the user to pick from (or reject) in the confirm list rather
// than guessed at here.
export function findMatchingEvents(
  events: CalendarEvent[],
  query: string,
  limit = 5,
): CalendarEvent[] {
  const queryWords = normalize(query).filter((word) => !STOPWORDS.has(word));
  if (queryWords.length === 0) return events.slice(0, limit);

  return events
    .map((event) => {
      const titleWords = new Set(normalize(event.title));
      const score = queryWords.filter((word) => titleWords.has(word)).length;
      return { event, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ event }) => event);
}
