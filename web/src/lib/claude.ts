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
            title: { type: "string" },
            start: {
              type: "string",
              description: "ISO 8601 datetime with UTC offset",
            },
            end: {
              type: "string",
              description: "ISO 8601 datetime with UTC offset",
            },
            location: { type: "string" },
            recurrence: {
              type: "string",
              description:
                "An iCalendar RRULE body (RFC 5545) if this event repeats, e.g. 'FREQ=WEEKLY;BYDAY=MO;COUNT=10' or 'FREQ=DAILY;UNTIL=20261231T000000Z'. Omit the 'RRULE:' prefix. Omit this field entirely for a one-off event. If the user states no end ('every Monday'), default to COUNT=52.",
            },
          },
          required: ["title", "start", "end"],
        },
      },
      query_start: {
        type: "string",
        description: "ISO 8601 datetime — only when intent is 'query'",
      },
      query_end: {
        type: "string",
        description: "ISO 8601 datetime — only when intent is 'query'",
      },
      search_query: {
        type: "string",
        description:
          "Only when intent is 'update' or 'delete': a short phrase describing the existing event to find (e.g. 'dentist appointment', 'team sync'), used to search the calendar for it. Omit otherwise.",
      },
      search_start: {
        type: "string",
        description:
          "Only when intent is 'update' or 'delete': ISO 8601 start of the date range to search for the target event, inferred from context (e.g. 'tomorrow's dentist' -> tomorrow). Omit otherwise.",
      },
      search_end: {
        type: "string",
        description:
          "Only when intent is 'update' or 'delete': ISO 8601 end of the search range. Omit otherwise.",
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
    opts.forceCreateIntent
      ? `This input is an image or document, not a typed question — always set intent to "create". Extract every distinct event you can find; a flyer or schedule may contain many.`
      : [
          `Set intent to "query" if the text is a question about the calendar (e.g. "what's on Saturday", "am I free Tuesday afternoon") rather than a request to add something — in that case leave candidates empty and set query_start/query_end to the date range the question refers to.`,
          `Set intent to "update" if the text asks to change, reschedule, rename, or move an existing event — leave candidates empty, describe the event to find in search_query, give a search date range in search_start/search_end, and put only the fields that should change in changes.`,
          `Set intent to "delete" if the text asks to cancel, delete, or remove an existing event — leave candidates empty, and set search_query and a search_start/search_end range the same way as for "update".`,
          `Set intent to "unknown" if the text is none of create/query/update/delete.`,
        ].join(" "),
    `If a create request describes a repeating event ("every Monday", "daily until June", "weekly for 8 weeks"), set that candidate's recurrence field to an RRULE body.`,
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
      title: string;
      start: string;
      end: string;
      location?: string;
      recurrence?: string;
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
      title: c.title,
      start: c.start,
      end: c.end,
      location: c.location,
      timezone: opts.timezone,
      recurrence: c.recurrence ? [`RRULE:${c.recurrence}`] : undefined,
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
