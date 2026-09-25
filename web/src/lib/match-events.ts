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
  // Left over from a possessive once punctuation is stripped ("sahana's" ->
  // "sahana s"), and would otherwise match any title with a stray "s".
  "s",
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

  return scoreEvents(events, queryWords)
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ event }) => event);
}

// For answering "when is X" rather than picking an event to edit: only the
// events tied for the best score, in calendar order. Returning every
// partial match would answer "when is Sahana's hippity hop" with Sasha's
// hippity hop and every "Sahana ..." event too. Several events can tie
// (each occurrence of a recurring class, or "when is hippity hop" matching
// both kids' classes equally) and all of them are the answer.
export function findBestMatchingEvents(
  events: CalendarEvent[],
  query: string,
  limit = 5,
): CalendarEvent[] {
  const queryWords = normalize(query).filter((word) => !STOPWORDS.has(word));
  if (queryWords.length === 0) return [];

  const scored = scoreEvents(events, queryWords);
  const best = Math.max(0, ...scored.map(({ score }) => score));
  if (best === 0) return [];
  return scored
    .filter(({ score }) => score === best)
    .slice(0, limit)
    .map(({ event }) => event);
}

function scoreEvents(events: CalendarEvent[], queryWords: string[]): { event: CalendarEvent; score: number }[] {
  return events.map((event) => {
    const titleWords = new Set(normalize(event.title));
    const score = queryWords.filter((word) => titleWords.has(word)).length;
    return { event, score };
  });
}
