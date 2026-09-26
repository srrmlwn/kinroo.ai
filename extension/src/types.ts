// title/start/end are "" when the source never stated them — the confirm
// screen makes the user fill them in before the event can be saved.
export interface EventCandidate {
  title: string;
  start: string; // ISO 8601, or "" if unknown
  end: string; // ISO 8601, or "" if unknown
  timezone?: string;
  location?: string;
  recurrence?: string[]; // iCalendar lines (RFC 5545), e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20261126T180000Z"]
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
}

// A confirm-list row is one of three write intents. "update"/"delete" carry
// `original` (the existing event as found on the server) purely for
// display — the write only needs eventId.
export type EventAction =
  | { type: "create"; candidate: EventCandidate }
  | { type: "update"; eventId: string; original: CalendarEvent; candidate: EventCandidate }
  | { type: "delete"; eventId: string; original: CalendarEvent };

export interface ParseResponse {
  intent: "create" | "query" | "update" | "delete" | "unknown";
  actions: EventAction[];
  answer?: string;
  answerLead?: string; // "Yes." / "No." for a yes/no question
  queryEvents?: CalendarEvent[];
  usedLLM: boolean;
  // The user's "add without asking" setting for the extension.
  autoApply?: boolean;
  inputType: "text" | "image" | "pdf";
}

// A confirm-list row as the panel/background flows build and edit it —
// the parsed action plus UI-only state (whether it's checked, and any
// scheduling conflicts found for a "create" row).
export interface EditableAction {
  action: EventAction;
  selected: boolean;
  conflicts?: CalendarEvent[];
  // Set after a confirm where only some rows went through: `saved` rows are
  // already on the calendar and must never be sent again (a retry of the
  // whole list used to duplicate them); `saveError` is why a row didn't.
  saved?: boolean;
  saveError?: string;
}

export interface CreateEventsResponse {
  events: Array<
    | { ok: true; action: EventAction["type"]; event?: CalendarEvent }
    | { ok: false; action: EventAction["type"]; error: string }
  >;
}
