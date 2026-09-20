import { getEvents } from "./api";
import type { EditableAction } from "./types";

// Best-effort: fetches everything already on the calendar across the span
// of the "create" rows in one call, then flags per-row overlaps
// client-side. "update"/"delete" rows are left alone — they operate on an
// event that's already on the calendar, so it isn't a useful "conflict"
// with itself. Shared by the popup and the right-click context-menu flow,
// which both build a confirm list from parsed actions. A failure here
// (offline, expired session) must never block confirming — the write path
// doesn't depend on it.
export async function annotateConflicts(items: EditableAction[]): Promise<EditableAction[]> {
  const creates = items.filter(
    (item): item is EditableAction & { action: Extract<EditableAction["action"], { type: "create" }> } =>
      item.action.type === "create",
  );
  if (creates.length === 0) return items;

  const starts = creates.map((item) => new Date(item.action.candidate.start).getTime());
  const ends = creates.map((item) => new Date(item.action.candidate.end).getTime());
  const rangeStart = new Date(Math.min(...starts)).toISOString();
  const rangeEnd = new Date(Math.max(...ends)).toISOString();

  try {
    const { events } = await getEvents(rangeStart, rangeEnd);
    return items.map((item) => {
      if (item.action.type !== "create") return item;
      const itemStart = new Date(item.action.candidate.start).getTime();
      const itemEnd = new Date(item.action.candidate.end).getTime();
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
