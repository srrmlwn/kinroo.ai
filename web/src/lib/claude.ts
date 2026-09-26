import Anthropic from "@anthropic-ai/sdk";
import type { EventCandidate } from "./google-calendar";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ apiKey });
  }
  return client;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "interpret_calendar_request",
  description:
    "Interpret a natural-language calendar request, or extract calendar events found in an image or document.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: ["create", "query", "update", "delete", "unknown"],
        description:
          "'create' to add new event(s), 'query' for a question about the calendar, 'update' to modify an existing event (reschedule, rename, change location), 'delete' to cancel/remove an existing event, 'unknown' if none of these.",
      },
      candidates: {
        type: "array",
        description: "Every distinct event found. Empty for a pure query.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "The actual name of the event or activity (e.g. a class, appointment, or meeting name) — never a field label from the source text like 'Meets' or 'Activity', and never a page heading or button label like 'Event details' or 'Add to calendar'. Omit if nothing in the input names the event.",
            },
            start: {
              type: "string",
              description:
                "ISO 8601 datetime with UTC offset. Omit if the input gives no date or time for this event.",
            },
            end: {
              type: "string",
              description: "ISO 8601 datetime with UTC offset. Omit whenever start is omitted.",
            },
            location: {
              type: "string",
              description: "Venue name and/or street address, if the input gives one.",
            },
            recurrence: {
              type: "string",
              description:
                "An iCalendar RRULE body (RFC 5545) if this event repeats, e.g. 'FREQ=WEEKLY;BYDAY=MO;COUNT=10' or 'FREQ=DAILY;UNTIL=20261231T000000Z'. Omit the 'RRULE:' prefix. Omit this field entirely for a one-off event. If the user states no end ('every Monday'), default to COUNT=52.",
            },
            exception_dates: {
              type: "array",
              items: { type: "string" },
              description:
                "Only alongside recurrence: ISO 8601 datetimes (with UTC offset) for individual occurrences the text explicitly excludes (e.g. 'except Thursday, November 26, 2026'). Use the same time-of-day as `start`. Omit if the text names no exceptions.",
            },
          },
          required: [],
        },
      },
      query_start: {
        type: "string",
        description:
          "ISO 8601 datetime — only when intent is 'query' and the question names a time period ('this weekend', 'on Saturday'). Omit for a question about a specific event with no date in it. 'Next', 'upcoming', and 'coming up' are not a time period — omit for those too; the next occurrence may well be later today.",
      },
      query_end: {
        type: "string",
        description: "ISO 8601 datetime — only when intent is 'query'",
      },
      search_query: {
        type: "string",
        description:
          "When intent is 'update' or 'delete', or a 'query' that asks about one specific event rather than a time period (e.g. 'when is Maya's piano lesson'): a short phrase describing the existing event to find (e.g. 'dentist appointment', 'Maya piano lesson'), used to search the calendar by title. Keep any person's name in it — it's often what tells two similar events apart. Omit otherwise.",
      },
      search_start: {
        type: "string",
        description:
          "Only when intent is 'update' or 'delete', AND the text gives a date/time hint for the event you're searching for (e.g. 'tomorrow's dentist', 'my Friday meeting'): ISO 8601 datetime with UTC offset marking the start of the range to search. If the text gives no date/time hint at all (e.g. 'cancel my dentist appointment'), omit this field entirely — do not guess a narrow range, the backend searches broadly by default when it's absent.",
      },
      search_end: {
        type: "string",
        description:
          "Only when intent is 'update' or 'delete' and search_start is set: ISO 8601 datetime with UTC offset marking the end of the search range. Omit whenever search_start is omitted.",
      },
      changes: {
        type: "object",
        description:
          "Only when intent is 'update': only the fields that should change (e.g. a new start/end to reschedule, a new title to rename). Omit fields that stay the same, and omit this object entirely otherwise.",
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601 datetime with UTC offset" },
          end: { type: "string", description: "ISO 8601 datetime with UTC offset" },
          location: { type: "string" },
        },
      },
    },
    required: ["intent", "candidates"],
  },
};

// RFC 5545 wants EXDATE values in the same basic UTC format Claude already
// produces for RRULE's UNTIL (e.g. "20261231T000000Z") — this converts one
// of the ISO 8601 datetimes Claude returns for exception_dates into that form.
export function toIcalUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export type ClaudeInput =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
  | { kind: "pdf"; base64: string };

export interface ExtractionResult {
  intent: "create" | "query" | "update" | "delete" | "unknown";
  candidates: EventCandidate[];
  queryRange?: { start: string; end: string };
  searchQuery?: string;
  searchRange?: { start: string; end: string };
  changes?: Pick<Partial<EventCandidate>, "title" | "start" | "end" | "location">;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export async function extractWithClaude(
  input: ClaudeInput,
  opts: {
    timezone: string;
    referenceDate: Date;
    defaultDurationMin: number;
    forceCreateIntent: boolean;
  },
): Promise<ExtractionResult> {
  const startedAt = Date.now();

  const referenceLabel = opts.referenceDate.toLocaleString("en-US", {
    timeZone: opts.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

  const systemPrompt = [
    `You turn a calendar request into structured data by calling the interpret_calendar_request tool. Always call the tool — never reply with plain text.`,
    `Current date/time: ${referenceLabel} (timezone: ${opts.timezone}). Resolve all relative dates and times ("tomorrow", "next Tuesday", "in an hour") against this.`,
    `Every start/end datetime you output must be ISO 8601 with a UTC offset (e.g. 2026-09-19T09:00:00-07:00).`,
    `If a candidate event has no explicit duration or end time, set end = start + ${opts.defaultDurationMin} minutes.`,
    `If the input gives no date or time for an event, omit its start and end rather than guessing one, and if nothing names the event, omit its title — the user fills in whatever is missing before anything is saved.`,
    opts.forceCreateIntent
      ? `This input is an image or document, not a typed question — always set intent to "create". Extract every distinct event you can find; a flyer or schedule may contain many.`
      : [
          `Set intent to "query" if the text is a question about the calendar (e.g. "what's on Saturday", "am I free Tuesday afternoon", "when is my dentist appointment") rather than a request to add something — in that case leave candidates empty. If it asks about a time period, set query_start/query_end to that range. If it asks about a specific event ("when is Maya's piano lesson", "where is the team offsite"), set search_query to describe it, and set query_start/query_end only if the question also gives a date hint.`,
          `Set intent to "update" if the text asks to change, reschedule, rename, or move an existing event — leave candidates empty, describe the event to find in search_query, and put only the fields that should change in changes. Only set search_start/search_end if the text itself gives a date/time hint for the event you're searching for ("tomorrow's dentist", "my Friday meeting") — if it gives none ("cancel my dentist appointment"), omit both rather than guessing a narrow range; the backend searches broadly by default when they're absent.`,
          `Set intent to "delete" if the text asks to cancel, delete, or remove an existing event — leave candidates empty, and set search_query (and search_start/search_end, following the same omit-if-no-hint rule) the same way as for "update".`,
          `Set intent to "unknown" if the text is none of create/query/update/delete.`,
        ].join(" "),
    `If a create request describes a repeating event ("every Monday", "daily until June", "weekly for 8 weeks"), set that candidate's recurrence field to an RRULE body. If the text also names specific dates to skip within that recurrence ("except the following dates: ..."), list each one in exception_dates.`,
  ].join(" ");

  const content: Anthropic.ContentBlockParam[] =
    input.kind === "text"
      ? [{ type: "text", text: input.text }]
      : input.kind === "image"
        ? [
            {
              type: "image",
              source: { type: "base64", media_type: input.mediaType, data: input.base64 },
            },
          ]
        : [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: input.base64 },
            },
          ];

  const response = await getClient().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "interpret_calendar_request" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) throw new Error("Claude did not return the expected tool call");

  const parsed = toolUse.input as {
    intent: "create" | "query" | "update" | "delete" | "unknown";
    candidates?: Array<{
      title?: string;
      start?: string;
      end?: string;
      location?: string;
      recurrence?: string;
      exception_dates?: string[];
    }>;
    query_start?: string;
    query_end?: string;
    search_query?: string;
    search_start?: string;
    search_end?: string;
    changes?: { title?: string; start?: string; end?: string; location?: string };
  };

  return {
    intent: opts.forceCreateIntent ? "create" : parsed.intent,
    candidates: (parsed.candidates ?? []).map((c) => ({
      title: c.title?.trim() ?? "",
      start: c.start ?? "",
      end: c.start ? (c.end ?? addMinutes(c.start, opts.defaultDurationMin)) : "",
      location: c.location,
      timezone: opts.timezone,
      recurrence: c.recurrence
        ? [
            `RRULE:${c.recurrence}`,
            ...(c.exception_dates?.length
              ? [`EXDATE:${c.exception_dates.map(toIcalUtc).join(",")}`]
              : []),
          ]
        : undefined,
    })),
    queryRange:
      parsed.query_start && parsed.query_end
        ? { start: parsed.query_start, end: parsed.query_end }
        : undefined,
    searchQuery: parsed.search_query,
    searchRange:
      parsed.search_start && parsed.search_end
        ? { start: parsed.search_start, end: parsed.search_end }
        : undefined,
    changes: parsed.changes,
    model: DEFAULT_MODEL,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    latencyMs: Date.now() - startedAt,
  };
}

const SELECT_TOOL: Anthropic.Tool = {
  name: "answer_calendar_question",
  description:
    "Records which of the listed calendar events answer the user's question, and, for a yes/no question, the yes/no answer. The app builds the reply shown to the user from the events you pick, so pick events only by their listed id — you cannot add, edit, or describe events here.",
  input_schema: {
    type: "object",
    properties: {
      event_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Ids (e.g. 'e3') of the events that answer the question, in the order they occur. For a yes/no question, the events that justify the answer (the ones that make someone busy, or that match what was asked about). Empty if no event answers it.",
      },
      yes_no: {
        type: "string",
        enum: ["yes", "no"],
        description:
          "Only for a question answerable with yes or no ('am I free Saturday afternoon', 'does Leo have anything Monday'). Omit for every other question.",
      },
    },
    required: ["event_ids"],
  },
};

export interface AnswerSelection {
  eventIds: string[];
  yesNo?: "yes" | "no";
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

// Second step of answering a calendar question: the caller has already
// fetched the events in the relevant window, and Claude picks which of them
// answer the question. Events are sent with short positional ids rather
// than Google's event ids (shorter, and an id that isn't in the list is
// easy to reject), and Claude only returns ids — the reply text is built in
// code from the real events, so it can't state a time or place that isn't
// on the calendar.
export async function selectAnswerEvents(
  question: string,
  events: Array<{ title: string; start: string; end: string; location?: string }>,
  opts: { timezone: string; referenceDate: Date },
): Promise<AnswerSelection> {
  const startedAt = Date.now();
  const fmt = (iso: string, withTime: boolean) =>
    new Date(iso).toLocaleString("en-US", {
      timeZone: opts.timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    });
  const eventLines = events.map((event, i) => {
    const allDay = !event.start.includes("T");
    const when = allDay ? `${fmt(event.start, false)} (all day)` : `${fmt(event.start, true)} – ${fmt(event.end, true)}`;
    return `e${i + 1} | ${when} | ${event.title}${event.location ? ` | ${event.location}` : ""}`;
  });

  const referenceLabel = opts.referenceDate.toLocaleString("en-US", {
    timeZone: opts.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });

  const systemPrompt = [
    `You answer a question about the user's calendar by choosing which of their events answer it.`,
    `Current date/time: ${referenceLabel} (timezone: ${opts.timezone}).`,
    `Each event is listed as: id | when | title | location. The titles are the user's own shorthand, often naming a family member ("Maya - Soccer", "Leo swim"). When a question names a person, only that person's events answer it — someone else's event with the same activity does not. Match activities by meaning, not exact wording ("gym" is gymnastics, "swimming" is swim).`,
    `An event's title says what it is; its location only says where it happens. A "Robotics" class held at a school gym is a robotics class, not a sports class. Use the location to decide what an event is only when the title doesn't say, or when the question asks about a place.`,
    `If the question names a time (a day, "this weekend", "Sunday morning", "after 6pm"), only events in that time answer it. All-day events belong to their day, so include them for a question about that day unless it asks about a specific time of day. If it asks for the next or first event, pick just that one: the earliest matching event that hasn't ended yet.`,
    `If nothing answers the question, return an empty list — never pick a loosely related event to have something to show.`,
  ].join(" ");

  const response = await getClient().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [SELECT_TOOL],
    tool_choice: { type: "tool", name: "answer_calendar_question" },
    messages: [
      {
        role: "user",
        content: `Events:\n${eventLines.length ? eventLines.join("\n") : "(none)"}\n\nQuestion: ${question}`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) throw new Error("Claude did not return the expected tool call");
  const parsed = toolUse.input as { event_ids?: unknown; yes_no?: unknown };

  return {
    eventIds: Array.isArray(parsed.event_ids) ? parsed.event_ids.filter((id): id is string => typeof id === "string") : [],
    yesNo: parsed.yes_no === "yes" || parsed.yes_no === "no" ? parsed.yes_no : undefined,
    model: DEFAULT_MODEL,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    latencyMs: Date.now() - startedAt,
  };
}

const REPLY_TOOL: Anthropic.Tool = {
  name: "apply_reply_to_summary",
  description:
    "Records what the user's reply asks kinroo to do to the numbered events in a summary it sent. Each operation targets one numbered item. The app carries out the operations and reports back; it does nothing for items no operation mentions.",
  input_schema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: { type: "integer", description: "The item's number in the summary." },
            op: {
              type: "string",
              enum: ["undo", "change"],
              description:
                "'undo' reverses what kinroo did to that item: removes an event it added, reverts an event it changed, or restores one it canceled. 'change' edits the item — set only the fields the reply changes.",
            },
            title: { type: "string" },
            start: { type: "string", description: "ISO 8601 datetime with UTC offset." },
            end: { type: "string", description: "ISO 8601 datetime with UTC offset. Omit unless the reply states an end or a length." },
            location: { type: "string" },
          },
          required: ["item", "op"],
        },
      },
      unclear: {
        type: "boolean",
        description:
          "True if the reply asks for something that can't be expressed as undo/change on the listed items, or doesn't say which item it means when that matters. An acknowledgement like 'thanks' or 'looks good' is not unclear — it's zero operations.",
      },
    },
    required: ["operations", "unclear"],
  },
};

export interface ReplyOperation {
  item: number;
  op: "undo" | "change";
  title?: string;
  start?: string;
  end?: string;
  location?: string;
}

// Turns a free-text reply to an auto-apply summary email ("1 is at 7pm,
// remove 2") into per-item operations. Only returns operations — the app
// validates each against the batch and does the calendar writes itself.
export async function interpretSummaryReply(
  replyText: string,
  items: Array<{ n: number; line: string }>,
  opts: { timezone: string; referenceDate: Date },
): Promise<{ operations: ReplyOperation[]; unclear: boolean; model: string; promptTokens: number; completionTokens: number }> {
  const referenceLabel = opts.referenceDate.toLocaleString("en-US", {
    timeZone: opts.timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
  const system = [
    `The user emailed kinroo.ai some text; kinroo put the events it found on their calendar and replied with a numbered summary. The user has now replied to that summary. Work out what their reply asks for, as operations on the numbered items.`,
    `Current date/time: ${referenceLabel} (timezone: ${opts.timezone}). Resolve relative dates and times against it, and write datetimes as ISO 8601 with the UTC offset in effect on that date.`,
    `A new time on an event that already has a date keeps that date unless the reply names a different day. "Everything", "all of them" and similar apply to every listed item. Items the reply doesn't mention get no operation.`,
  ].join(" ");
  const summary = items.map((i) => `${i.n}. ${i.line}`).join("\n");

  const response = await getClient().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1024,
    system,
    tools: [REPLY_TOOL],
    tool_choice: { type: "tool", name: "apply_reply_to_summary" },
    messages: [{ role: "user", content: `Summary items:\n${summary}\n\nUser's reply:\n${replyText}` }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) throw new Error("Claude did not return the expected tool call");
  const parsed = toolUse.input as { operations?: unknown; unclear?: unknown };
  const operations = Array.isArray(parsed.operations)
    ? parsed.operations.filter(
        (op): op is ReplyOperation =>
          typeof op === "object" &&
          op !== null &&
          Number.isInteger((op as ReplyOperation).item) &&
          ((op as ReplyOperation).op === "undo" || (op as ReplyOperation).op === "change"),
      )
    : [];
  return {
    operations,
    unclear: parsed.unclear === true,
    model: DEFAULT_MODEL,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
  };
}
