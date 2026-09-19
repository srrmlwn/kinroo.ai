import { getEvents } from "./api";
import type { CalendarEvent } from "./types";

export interface WithConflicts {
  start: string;
  end: string;
  conflicts?: CalendarEvent[];
}

// Best-effort: fetches everything already on the calendar across the span
// of the given candidates in one call, then flags per-candidate overlaps
// client-side. Shared by the popup and the right-click context-menu flow,
// which both build a confirm list from parsed candidates. A failure here
// (offline, expired session) must never block confirming — the write path
// re-validates nothing missed here anyway.
export async function annotateConflicts<T extends WithConflicts>(items: T[]): Promise<T[]> {
  if (items.length === 0) return items;

  const starts = items.map((i) => new Date(i.start).getTime());
  const ends = items.map((i) => new Date(i.end).getTime());
  const rangeStart = new Date(Math.min(...starts)).toISOString();
  const rangeEnd = new Date(Math.max(...ends)).toISOString();

  try {
    const { events } = await getEvents(rangeStart, rangeEnd);
    return items.map((item) => {
      const itemStart = new Date(item.start).getTime();
      const itemEnd = new Date(item.end).getTime();
      const conflicts = events.filter((event) => {
        const eventStart = new Date(event.start).getTime();
        const eventEnd = new Date(event.end).getTime();
        return eventStart < itemEnd && eventEnd > itemStart;
      });
      return { ...item, conflicts: conflicts.length > 0 ? conflicts : undefined };
    });
  } catch {
    return items;
  }
}
