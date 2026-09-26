import { eq } from "drizzle-orm";
import { db } from "./db";
import { emailBatches } from "./db/schema";
import {
  deleteEvent,
  insertEvent,
  isCandidateComplete,
  listEvents,
  updateEvent,
  type CalendarEvent,
  type EventAction,
  type EventCandidate,
} from "./google-calendar";

// Email auto-apply (settings.email_auto_apply): instead of holding an
// emailed change until the user replies YES, kinroo applies everything it
// found, records what it did here as numbered items, and replies with a
// summary the user can correct — one-click undo links, or a free-text reply
// ("1 is at 7pm, remove 2"). Rollback is cheap: kinroo never adds guests,
// so a wrong event only ever shows up on the user's own calendar.

export type BatchItemStatus =
  | "applied" // written to the calendar
  | "undone" // written, then reverted by the user
  | "needs-info" // a create missing its date or title — not written
  | "duplicate" // a create that's already on the calendar — not written
  | "failed"; // the calendar write errored

export interface BatchItem {
  n: number; // 1-based, as shown in the summary email
  // What was parsed. For "applied" creates/updates, `action.candidate`
  // reflects the event as it is now, including any later reply edits.
  action: EventAction;
  status: BatchItemStatus;
  eventId?: string; // the event on the calendar, once written
  htmlLink?: string;
  edited?: boolean; // changed by a reply after it was applied
  error?: string;
}

export interface EmailBatch {
  id: string;
  userId: string;
  fromAddress: string;
  subject: string;
  items: BatchItem[];
}

// --- Applying ---------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ") // "[Adams] PTA meeting" matches "PTA meeting"
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// A create counts as already on the calendar when an existing event starts
// at the same moment (or on the same day, for all-day events) and one title
// contains the other — forwarding the same newsletter twice, or an invite
// that's already been accepted, shouldn't add a second copy.
export function findDuplicate(candidate: EventCandidate, existing: CalendarEvent[]): CalendarEvent | undefined {
  const want = normalizeTitle(candidate.title);
  if (!want) return undefined;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(candidate.start);
  return existing.find((event) => {
    const sameStart = allDay
      ? event.start.slice(0, 10) === candidate.start
      : Math.abs(Date.parse(event.start) - Date.parse(candidate.start)) < 60_000;
    if (!sameStart) return false;
    const have = normalizeTitle(event.title);
    return have !== "" && (have.includes(want) || want.includes(have));
  });
}

function withLabel(candidate: EventCandidate, subject: string): EventCandidate {
  const source = subject.trim() ? `"${subject.trim()}"` : "an email";
  return { ...candidate, description: `Added by kinroo.ai from ${source}.` };
}

async function applyItem(
  userId: string,
  calendarId: string,
  item: BatchItem,
  subject: string,
): Promise<BatchItem> {
  const { action } = item;
  try {
    if (action.type === "create") {
      if (!isCandidateComplete(action.candidate)) return { ...item, status: "needs-info" };
      const allDay = /^\d{4}-\d{2}-\d{2}$/.test(action.candidate.start);
      const windowStart = allDay ? `${action.candidate.start}T00:00:00Z` : action.candidate.start;
      const windowEnd = allDay
        ? new Date(Date.parse(`${action.candidate.start}T00:00:00Z`) + 36 * 3600_000).toISOString()
        : action.candidate.end;
      const existing = await listEvents(userId, calendarId, windowStart, windowEnd);
      const duplicate = findDuplicate(action.candidate, existing);
      if (duplicate) {
        return { ...item, status: "duplicate", eventId: duplicate.id, htmlLink: duplicate.htmlLink };
      }
      const created = await insertEvent(userId, calendarId, withLabel(action.candidate, subject));
      return { ...item, status: "applied", eventId: created.id, htmlLink: created.htmlLink };
    }
    if (action.type === "update") {
      if (!isCandidateComplete(action.candidate)) return { ...item, status: "needs-info" };
      const updated = await updateEvent(userId, calendarId, action.eventId, action.candidate);
      return { ...item, status: "applied", eventId: action.eventId, htmlLink: updated.htmlLink };
    }
    await deleteEvent(userId, calendarId, action.eventId);
    return { ...item, status: "applied", eventId: action.eventId };
  } catch (err) {
    console.error("[email-batch] failed to apply item", item.n, err);
    return { ...item, status: "failed", error: String(err) };
  }
}

export async function applyEmailActions(opts: {
  userId: string;
  calendarId: string;
  fromAddress: string;
  subject: string;
  actions: EventAction[];
}): Promise<EmailBatch> {
  const items: BatchItem[] = [];
  // Sequential, not parallel: two creates in one email can duplicate each
  // other, and the second one's duplicate check needs to see the first.
  for (const [i, action] of opts.actions.entries()) {
    items.push(await applyItem(opts.userId, opts.calendarId, { n: i + 1, action, status: "applied" }, opts.subject));
  }
  const [row] = await db
    .insert(emailBatches)
    .values({ userId: opts.userId, fromAddress: opts.fromAddress, subject: opts.subject, items })
    .returning({ id: emailBatches.id });
  return { id: row.id, userId: opts.userId, fromAddress: opts.fromAddress, subject: opts.subject, items };
}

// --- Loading and saving -----------------------------------------------------

export async function loadBatch(batchId: string, userId: string): Promise<EmailBatch | null> {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return null;
  const [row] = await db.select().from(emailBatches).where(eq(emailBatches.id, batchId)).limit(1);
  if (!row || row.userId !== userId) return null;
  return {
    id: row.id,
    userId: row.userId,
    fromAddress: row.fromAddress,
    subject: row.subject,
    items: row.items as BatchItem[],
  };
}

export async function saveBatchItems(batch: EmailBatch): Promise<void> {
  await db
    .update(emailBatches)
    .set({ items: batch.items, updatedAt: new Date() })
    .where(eq(emailBatches.id, batch.id));
}

// --- Undo and edit ----------------------------------------------------------

function toCandidate(event: CalendarEvent, timezone: string): EventCandidate {
  return {
    title: event.title,
    start: event.start,
    end: event.end,
    location: event.location,
    timezone,
  };
}

// Reverts one applied item: an added event is deleted, a changed event
// goes back to how it was, a canceled event is re-created. Items that were
// never written (needs-info, duplicate, failed) or are already undone are
// returned unchanged.
export async function undoItem(
  userId: string,
  calendarId: string,
  timezone: string,
  item: BatchItem,
): Promise<BatchItem> {
  if (item.status !== "applied" || !item.eventId) return item;
  const { action } = item;
  if (action.type === "create") {
    await deleteEvent(userId, calendarId, item.eventId);
  } else if (action.type === "update") {
    await updateEvent(userId, calendarId, item.eventId, toCandidate(action.original, timezone));
  } else {
    const restored = await insertEvent(userId, calendarId, toCandidate(action.original, timezone));
    return { ...item, status: "undone", eventId: restored.id, htmlLink: restored.htmlLink };
  }
  return { ...item, status: "undone" };
}

// The items an undo link covers: one numbered item, or every item in the
// batch for "Undo everything from this email".
export function itemsForLink(batch: EmailBatch, item: number | "all"): BatchItem[] {
  return item === "all" ? batch.items : batch.items.filter((i) => i.n === item);
}

// Undoes every still-applied item an undo link covers and saves the batch.
// Safe to repeat: already-undone items are skipped, so a double-submit or
// revisiting the link doesn't re-create or re-delete anything.
export async function undoFromLink(
  batch: EmailBatch,
  item: number | "all",
  calendarId: string,
  timezone: string,
): Promise<{ undone: number; failed: number }> {
  let undone = 0;
  let failed = 0;
  const targets = new Set(itemsForLink(batch, item).map((i) => i.n));
  for (const [index, current] of batch.items.entries()) {
    if (!targets.has(current.n) || current.status !== "applied") continue;
    try {
      batch.items[index] = await undoItem(batch.userId, calendarId, timezone, current);
      undone++;
    } catch (err) {
      console.error("[email-batch] undo from link failed", current.n, err);
      failed++;
    }
  }
  await saveBatchItems(batch);
  return { undone, failed };
}

export type ItemChange = Partial<Pick<EventCandidate, "title" | "start" | "end" | "location">>;

// Applies a correction from a reply to one item. An applied create or
// update is patched in place; a needs-info create is written once the
// change fills in what was missing. Cancellations, duplicates, and undone
// items can't be edited — undo is the only thing that applies to them.
export async function editItem(
  userId: string,
  calendarId: string,
  item: BatchItem,
  change: ItemChange,
  subject: string,
): Promise<{ item: BatchItem; error?: string }> {
  const { action } = item;
  if (action.type === "delete") return { item, error: "is a cancellation — reply \"undo\" to restore it instead" };
  if (item.status !== "applied" && item.status !== "needs-info") {
    return { item, error: `can't be edited (${item.status === "undone" ? "already removed" : item.status})` };
  }

  const current = action.candidate;
  let start = change.start ?? current.start;
  let end = change.end ?? current.end;
  // Moving the start without saying when it ends keeps the event's length.
  if (change.start && !change.end && current.start && current.end) {
    const length = Date.parse(current.end) - Date.parse(current.start);
    if (length > 0) end = new Date(Date.parse(change.start) + length).toISOString();
  }
  if (start && !end) end = new Date(Date.parse(start) + 60 * 60_000).toISOString();
  if (!start) start = "";
  const next: EventCandidate = {
    ...current,
    title: change.title ?? current.title,
    location: change.location ?? current.location,
    start,
    end,
  };
  const nextAction: EventAction = { ...action, candidate: next };

  if (!isCandidateComplete(next)) {
    return { item: { ...item, action: nextAction }, error: "still needs a date/time and a title" };
  }

  try {
    if (item.status === "needs-info") {
      const created = await insertEvent(userId, calendarId, withLabel(next, subject));
      return {
        item: { ...item, action: nextAction, status: "applied", eventId: created.id, htmlLink: created.htmlLink, edited: true },
      };
    }
    const updated = await updateEvent(userId, calendarId, item.eventId!, next);
    return { item: { ...item, action: nextAction, htmlLink: updated.htmlLink ?? item.htmlLink, edited: true } };
  } catch (err) {
    console.error("[email-batch] failed to edit item", item.n, err);
    return { item, error: "couldn't be saved to your calendar — try again" };
  }
}

// --- Rendering --------------------------------------------------------------

function formatWhen(start: string, end: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const day = new Date(`${start}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return `${day} (all day)`;
  }
  const s = new Date(start);
  const e = new Date(end);
  const day = s.toLocaleDateString("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  return `${day}, ${time(s)}–${time(e)}`;
}

export function describe(item: BatchItem, timezone: string): string {
  const { action } = item;
  if (action.type === "delete") {
    return `${action.original.title} — ${formatWhen(action.original.start, action.original.end, timezone)}`;
  }
  const c = action.candidate;
  const title = c.title.trim() || "(no title)";
  const when = c.start ? formatWhen(c.start, c.end, timezone) : "no date or time found";
  return `${title} — ${when}${c.location ? ` · ${c.location}` : ""}`;
}

export function verb(item: BatchItem): string {
  const type = item.action.type;
  if (item.status === "undone") {
    return type === "create" ? "Removed" : type === "update" ? "Change undone" : "Restored";
  }
  return type === "create" ? "Added" : type === "update" ? "Changed" : "Canceled";
}

// One line per item, with its current state — what the reply interpreter
// sees, so "remove 2" and "3 is at 6pm" resolve against the same wording
// the user read in the summary.
export function itemStateLine(item: BatchItem, timezone: string): string {
  const state =
    item.status === "applied"
      ? verb(item)
      : item.status === "needs-info"
        ? "Not added yet (missing a date/time or title)"
        : item.status === "duplicate"
          ? "Already on the calendar, not added"
          : item.status === "undone"
            ? verb(item)
            : "Failed to save";
  return `${state}: ${describe(item, timezone)}`;
}

export interface SummaryLinks {
  undo: (item: number | "all") => string;
}

// Plain text on purpose: it renders the same in every mail client, and the
// numbers are what a reply refers back to.
export function renderBatchSummary(batch: EmailBatch, timezone: string, links: SummaryLinks): string {
  const lines: string[] = [];
  const applied = batch.items.filter((i) => i.status === "applied");
  const needsInfo = batch.items.filter((i) => i.status === "needs-info");
  const other = batch.items.filter((i) => i.status !== "applied" && i.status !== "needs-info");

  if (applied.length) {
    lines.push("On your calendar:");
    for (const item of applied) {
      lines.push(`${item.n}. ${verb(item)}: ${describe(item, timezone)}${item.edited ? " (edited)" : ""}`);
      const undoLabel = item.action.type === "create" ? "Remove" : "Undo";
      lines.push(`   ${undoLabel}: ${links.undo(item.n)}`);
      if (item.htmlLink && item.action.type !== "delete") lines.push(`   Edit in Google Calendar: ${item.htmlLink}`);
    }
    lines.push("");
  }
  if (needsInfo.length) {
    lines.push("Not added yet — missing a date/time or title:");
    for (const item of needsInfo) lines.push(`${item.n}. ${describe(item, timezone)}`);
    lines.push("");
  }
  if (other.length) {
    for (const item of other) {
      const label =
        item.status === "duplicate"
          ? "Already on your calendar, not added again"
          : item.status === "undone"
            ? verb(item)
            : "Couldn't save this one";
      lines.push(`${item.n}. ${label}: ${describe(item, timezone)}`);
    }
    lines.push("");
  }

  if (!applied.length && !needsInfo.length) {
    lines.push("Nothing new was added.");
  } else {
    lines.push('To change anything, reply in plain words — for example "1 is at 7pm", "remove 2", or');
    lines.push('"3 is on Oct 1 at 6pm" to add one that was missing a time.');
    if (applied.length > 1) lines.push(`Undo everything from this email: ${links.undo("all")}`);
  }
  return lines.join("\n");
}

export function summarySubject(batch: EmailBatch): string {
  const added = batch.items.filter((i) => i.status === "applied").length;
  const needs = batch.items.filter((i) => i.status === "needs-info").length;
  const parts = [];
  if (added) parts.push(`${added} change${added === 1 ? "" : "s"} made`);
  if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} a date`);
  const head = parts.length ? parts.join(", ") : "Nothing added";
  return batch.subject ? `${head}: ${batch.subject}` : head;
}
