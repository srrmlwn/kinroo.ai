import { getEvents } from "./api";
import { parseEventDate } from "./dates";
import type { EditableAction } from "./types";

// Best-effort: fetches everything already on the calendar across the span
// of the "create" rows in one call, then flags per-row overlaps
// client-side. "update"/"delete" rows are left alone — they operate on an
// event that's already on the calendar, so it isn't a useful "conflict"
// with itself. Shared by the panel and the right-click context-menu flow,
// which both build a confirm list from parsed actions. A failure here
// (offline, expired session) must never block confirming — the write path
// doesn't depend on it.
export async function annotateConflicts(items: EditableAction[]): Promise<EditableAction[]> {
  // A create with no date yet (the user still has to fill it in) has
  // nothing to overlap with, and would make the fetched range NaN.
  const creates = items.filter(
    (item): item is EditableAction & { action: Extract<EditableAction["action"], { type: "create" }> } =>
      item.action.type === "create" &&
      !Number.isNaN(Date.parse(item.action.candidate.start)) &&
      !Number.isNaN(Date.parse(item.action.candidate.end)),
  );
  if (creates.length === 0) return items;

  const starts = creates.map((item) => parseEventDate(item.action.candidate.start).getTime());
  const ends = creates.map((item) => parseEventDate(item.action.candidate.end).getTime());
  const rangeStart = new Date(Math.min(...starts)).toISOString();
  const rangeEnd = new Date(Math.max(...ends)).toISOString();

  try {
    const { events } = await getEvents(rangeStart, rangeEnd);
    return items.map((item) => {
      if (item.action.type !== "create") return item;
      const itemStart = parseEventDate(item.action.candidate.start).getTime();
      const itemEnd = parseEventDate(item.action.candidate.end).getTime();
      const conflicts = events.filter((event) => {
        const eventStart = parseEventDate(event.start).getTime();
        const eventEnd = parseEventDate(event.end).getTime();
        return eventStart < itemEnd && eventEnd > itemStart;
      });
      return { ...item, conflicts: conflicts.length > 0 ? conflicts : undefined };
    });
  } catch (err) {
    // Never block confirming on this — but a silent catch here is
    // indistinguishable from "no conflicts found," which makes a real
    // failure (expired session, a bad calendar ID, a network blip)
    // invisible. Logging costs nothing and makes that failure mode
    // debuggable from the extension's own console.
    console.error("[conflicts] check failed, showing no warnings", err);
    return items;
  }
}
