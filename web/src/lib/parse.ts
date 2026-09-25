import { getUserSettings } from "./user-settings";
import {
  looksLikeQuery,
  looksLikeRecurring,
  looksLikeModification,
  fastPathExtractCreate,
  fastPathQueryRange,
} from "./fast-path";
import { extractWithClaude, selectAnswerEvents, type ClaudeInput } from "./claude";
import { listEvents, type EventCandidate, type EventAction, type CalendarEvent } from "./google-calendar";
import { findMatchingEvents, findBestMatchingEvents } from "./match-events";
import { formatQueryAnswer } from "./format-answer";
import { logLlmCall } from "./llm-log";

export type ParseInput =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
  | { kind: "pdf"; base64: string };

export interface ParseOutcome {
  intent: "create" | "query" | "update" | "delete" | "unknown";
  actions: EventAction[];
  answer?: string;
  // "Yes." / "No." for a yes/no question — shown above the event tiles,
  // since the extension renders tiles instead of `answer` when it has events.
  // Already included at the start of `answer` for text-only channels.
  answerLead?: string;
  // The same events `answer` is a text rendering of — lets callers that can
  // show real UI (the extension's event-tile list) skip the text and render
  // structured data instead. Channels that can only show text (email) keep
  // using `answer`.
  queryEvents?: CalendarEvent[];
  usedLlm: boolean;
  inputType: "text" | "image" | "pdf";
}

async function answerQuery(
  userId: string,
  calendarId: string,
  timezone: string,
  range: { start: Date | string; end: Date | string },
): Promise<{ answer: string; events: CalendarEvent[] }> {
  const start = typeof range.start === "string" ? range.start : range.start.toISOString();
  const end = typeof range.end === "string" ? range.end : range.end.toISOString();
  const events = await listEvents(userId, calendarId, start, end);
  return { answer: formatQueryAnswer(events, timezone), events };
}

// "When is Sahana's hippity hop": search upcoming events by title and
// answer with just the best matches, rather than listing every event in
// whatever range Claude guessed for a question that named no dates.
async function answerEventLookup(
  userId: string,
  calendarId: string,
  timezone: string,
  searchQuery: string,
  range: { start: string; end: string } | undefined,
  referenceDate: Date,
): Promise<{ answer: string; events: CalendarEvent[] }> {
  const start = range?.start ?? referenceDate.toISOString();
  const end = range?.end ?? new Date(referenceDate.getTime() + DEFAULT_SEARCH_WINDOW_MS.after).toISOString();
  const events = findBestMatchingEvents(await listEvents(userId, calendarId, start, end), searchQuery);
  if (events.length === 0) {
    return { answer: `Couldn't find "${searchQuery}" on your calendar${range ? " then" : " in the next 60 days"}.`, events };
  }
  return { answer: formatQueryAnswer(events, timezone), events };
}

// How a question Claude classified as a query gets answered:
// - "select" (default): fetch the events in the question's window and have
//   Claude pick which ones answer it, by id. Handles synonyms, people,
//   locations, times of day, yes/no, "what's next".
// - "keyword": the earlier approach — title keyword matching for a named
//   event, otherwise every event in the range. One Claude call instead of
//   two. Kept as a fallback and so the query eval can compare the two.
type QueryAnswerStrategy = "select" | "keyword";
function queryAnswerStrategy(): QueryAnswerStrategy {
  return process.env.QUERY_ANSWER_STRATEGY === "keyword" ? "keyword" : "select";
}

// Upper bound on events sent to Claude for selection — 60 days of a busy
// family calendar is well under this; it only guards a runaway window.
const MAX_EVENTS_FOR_SELECTION = 300;

async function answerBySelection(
  userId: string,
  calendarId: string,
  timezone: string,
  question: string,
  range: { start: string; end: string } | undefined,
  referenceDate: Date,
): Promise<{
  answer: string;
  answerLead?: string;
  events: CalendarEvent[];
  usage: { promptTokens: number; completionTokens: number; latencyMs: number };
}> {
  const start = range?.start ?? referenceDate.toISOString();
  const end = range?.end ?? new Date(referenceDate.getTime() + DEFAULT_SEARCH_WINDOW_MS.after).toISOString();
  const windowEvents = (await listEvents(userId, calendarId, start, end)).slice(0, MAX_EVENTS_FOR_SELECTION);

  const selection = await selectAnswerEvents(question, windowEvents, { timezone, referenceDate });
  const picked = new Set<number>();
  for (const id of selection.eventIds) {
    const index = Number(/^e(\d+)$/.exec(id.trim())?.[1]) - 1;
    if (index >= 0 && index < windowEvents.length) picked.add(index);
  }
  // listEvents returns events in start order, so index order is time order.
  const events = [...picked].sort((a, b) => a - b).map((i) => windowEvents[i]);

  const answerLead = selection.yesNo === "yes" ? "Yes." : selection.yesNo === "no" ? "No." : undefined;
  const body =
    events.length > 0
      ? formatQueryAnswer(events, timezone)
      : answerLead
        ? ""
        : "Nothing on your calendar matches that.";
  return {
    answer: [answerLead, body].filter(Boolean).join("\n"),
    answerLead,
    events,
    usage: {
      promptTokens: selection.promptTokens,
      completionTokens: selection.completionTokens,
      latencyMs: selection.latencyMs,
    },
  };
}

// Default search window when Claude doesn't infer one (or the fast path
// never reaches Claude at all) — wide enough to catch "cancel my dentist
// thing" without a date, narrow enough to keep the candidate list small.
const DEFAULT_SEARCH_WINDOW_MS = { before: 24 * 60 * 60_000, after: 60 * 24 * 60 * 60_000 };

// Google's events.list rejects timeMin/timeMax that aren't a full RFC3339
// datetime with an offset — a bare date ("2026-09-21") is valid ISO 8601
// but not accepted, and would otherwise take the whole request down with
// it. Guards the range Claude returns before it ever reaches that call;
// anything that doesn't match falls back to the wide default window rather
// than surfacing as a hard failure.
export function isFullIsoDatetime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

function validRangeOrUndefined(
  range: { start: string; end: string } | undefined,
): { start: string; end: string } | undefined {
  if (!range) return undefined;
  return isFullIsoDatetime(range.start) && isFullIsoDatetime(range.end) ? range : undefined;
}

async function findEventActions(
  userId: string,
  calendarId: string,
  timezone: string,
  intent: "update" | "delete",
  searchQuery: string,
  searchRange: { start: string; end: string } | undefined,
  changes: Partial<EventCandidate> | undefined,
  referenceDate: Date,
): Promise<EventAction[]> {
  const validRange = validRangeOrUndefined(searchRange);
  const searchStart =
    validRange?.start ?? new Date(referenceDate.getTime() - DEFAULT_SEARCH_WINDOW_MS.before).toISOString();
  const searchEnd =
    validRange?.end ?? new Date(referenceDate.getTime() + DEFAULT_SEARCH_WINDOW_MS.after).toISOString();

  const events = await listEvents(userId, calendarId, searchStart, searchEnd);
  const matches = findMatchingEvents(events, searchQuery);

  return matches.map((event) =>
    intent === "delete"
      ? { type: "delete", eventId: event.id, original: event }
      : {
          type: "update",
          eventId: event.id,
          original: event,
          candidate: {
            title: changes?.title ?? event.title,
            start: changes?.start ?? event.start,
            end: changes?.end ?? event.end,
            timezone,
            location: changes?.location ?? event.location,
          },
        },
  );
}

export async function parseInput(
  userId: string,
  input: ParseInput,
  channel: string,
): Promise<ParseOutcome> {
  const userSettings = await getUserSettings(userId);
  const referenceDate = new Date();

  // Image/PDF always goes straight to Claude — an uploaded file is never a
  // query or an edit request, and the fast path can't read pixels.
  if (input.kind !== "text") {
    const claudeInput: ClaudeInput =
      input.kind === "image"
        ? { kind: "image", base64: input.base64, mediaType: input.mediaType }
        : { kind: "pdf", base64: input.base64 };

    const result = await extractWithClaude(claudeInput, {
      timezone: userSettings.timezone,
      referenceDate,
      defaultDurationMin: userSettings.defaultEventDurationMin,
      forceCreateIntent: true,
    });

    logLlmCall({
      userId,
      channel,
      inputType: input.kind,
      usedLlm: true,
      model: result.model,
      intent: result.intent,
      candidateCount: result.candidates.length,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
    });

    return {
      intent: "create",
      actions: result.candidates.map((candidate) => ({ type: "create", candidate })),
      usedLlm: true,
      inputType: input.kind,
    };
  }

  const text = input.text.trim();
  const isLikelyQuery = looksLikeQuery(text);
  const isLikelyModification = !isLikelyQuery && looksLikeModification(text);

  if (isLikelyQuery) {
    const range = fastPathQueryRange(text, referenceDate, userSettings.timezone);
    if (range) {
      const startedAt = Date.now();
      const { answer, events } = await answerQuery(
        userId,
        userSettings.defaultCalendarId,
        userSettings.timezone,
        range,
      );
      logLlmCall({
        userId,
        channel,
        inputType: "text",
        usedLlm: false,
        intent: "query",
        candidateCount: 0,
        latencyMs: Date.now() - startedAt,
      });
      return { intent: "query", actions: [], answer, queryEvents: events, usedLlm: false, inputType: "text" };
    }
  } else if (!isLikelyModification) {
    // Recurring phrasing ("every Monday") skips the fast path — it has no
    // way to encode an RRULE — and falls through to the Claude branch below.
    const candidate = looksLikeRecurring(text)
      ? null
      : fastPathExtractCreate(
          text,
          referenceDate,
          userSettings.timezone,
          userSettings.defaultEventDurationMin,
        );
    if (candidate) {
      logLlmCall({
        userId,
        channel,
        inputType: "text",
        usedLlm: false,
        intent: "create",
        candidateCount: 1,
        latencyMs: 0,
      });
      return {
        intent: "create",
        actions: [{ type: "create", candidate }],
        usedLlm: false,
        inputType: "text",
      };
    }
  }

  // Fast path couldn't confidently handle it (or the text looks like a
  // query/edit request the fast path can't do) — fall back to Claude for
  // full intent classification and extraction in one call.
  const result = await extractWithClaude(
    { kind: "text", text },
    {
      timezone: userSettings.timezone,
      referenceDate,
      defaultDurationMin: userSettings.defaultEventDurationMin,
      forceCreateIntent: false,
    },
  );

  let answer: string | undefined;
  let answerLead: string | undefined;
  let queryEvents: CalendarEvent[] | undefined;
  const usage = {
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
  };
  let actions: EventAction[] = result.candidates.map((candidate) => ({ type: "create", candidate }));

  const validQueryRange = validRangeOrUndefined(result.queryRange);
  if (result.intent === "query" && queryAnswerStrategy() === "select") {
    const selected = await answerBySelection(
      userId,
      userSettings.defaultCalendarId,
      userSettings.timezone,
      text,
      validQueryRange,
      referenceDate,
    );
    ({ answer, answerLead, events: queryEvents } = selected);
    usage.promptTokens += selected.usage.promptTokens;
    usage.completionTokens += selected.usage.completionTokens;
    usage.latencyMs += selected.usage.latencyMs;
  } else if (result.intent === "query" && result.searchQuery) {
    ({ answer, events: queryEvents } = await answerEventLookup(
      userId,
      userSettings.defaultCalendarId,
      userSettings.timezone,
      result.searchQuery,
      validQueryRange,
      referenceDate,
    ));
  } else if (result.intent === "query" && validQueryRange) {
    ({ answer, events: queryEvents } = await answerQuery(
      userId,
      userSettings.defaultCalendarId,
      userSettings.timezone,
      validQueryRange,
    ));
  } else if (result.intent === "update" || result.intent === "delete") {
    actions = await findEventActions(
      userId,
      userSettings.defaultCalendarId,
      userSettings.timezone,
      result.intent,
      result.searchQuery ?? text,
      result.searchRange,
      result.changes,
      referenceDate,
    );
  }

  logLlmCall({
    userId,
    channel,
    inputType: "text",
    usedLlm: true,
    model: result.model,
    intent: result.intent,
    candidateCount: actions.length,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    latencyMs: usage.latencyMs,
  });

  return {
    intent: result.intent,
    actions,
    answer,
    answerLead,
    queryEvents,
    usedLlm: true,
    inputType: "text",
  };
}
