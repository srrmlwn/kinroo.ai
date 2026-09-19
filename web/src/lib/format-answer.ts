import type { CalendarEvent } from "./google-calendar";

// Deterministic, no LLM call — the calendar data is the source of truth and
// this just relays it, so there's nothing to "phrase" that's worth the
// hallucination risk or extra cost for v1.
export function formatQueryAnswer(
  events: CalendarEvent[],
  timezone: string,
): string {
  if (events.length === 0) return "Nothing found for that time.";

  const lines = events.map((event) => {
    const time = event.start.includes("T")
      ? new Date(event.start).toLocaleString("en-US", {
          timeZone: timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : new Date(event.start).toLocaleDateString("en-US", {
          timeZone: timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
        });
    return `• ${event.title} — ${time}`;
  });

  return lines.join("\n");
}
