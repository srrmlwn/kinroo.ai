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
        enum: ["create", "query", "unknown"],
        description:
          "'create' to add event(s), 'query' if this is a question about the calendar, 'unknown' if neither.",
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
    },
    required: ["intent", "candidates"],
  },
};

export type ClaudeInput =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
  | { kind: "pdf"; base64: string };

export interface ExtractionResult {
  intent: "create" | "query" | "unknown";
  candidates: EventCandidate[];
  queryRange?: { start: string; end: string };
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
      : `Set intent to "query" if the text is a question about the calendar (e.g. "what's on Saturday", "am I free Tuesday afternoon") rather than a request to add something — in that case leave candidates empty and set query_start/query_end to the date range the question refers to. Set intent to "unknown" if the text is neither a creation request nor a calendar question.`,
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
    intent: "create" | "query" | "unknown";
    candidates?: Array<{
      title: string;
      start: string;
      end: string;
      location?: string;
      recurrence?: string;
    }>;
    query_start?: string;
    query_end?: string;
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
    model: DEFAULT_MODEL,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
    latencyMs: Date.now() - startedAt,
  };
}
