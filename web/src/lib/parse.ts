import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings as settingsTable } from "./db/schema";
import { looksLikeQuery, looksLikeRecurring, fastPathExtractCreate, fastPathQueryRange } from "./fast-path";
import { extractWithClaude, type ClaudeInput } from "./claude";
import { listEvents, type EventCandidate } from "./google-calendar";
import { formatQueryAnswer } from "./format-answer";
import { logLlmCall } from "./llm-log";

export type ParseInput =
  | { kind: "text"; text: string }
  | { kind: "image"; base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }
  | { kind: "pdf"; base64: string };

export interface ParseOutcome {
  intent: "create" | "query" | "unknown";
  candidates: EventCandidate[];
  answer?: string;
  usedLlm: boolean;
  inputType: "text" | "image" | "pdf";
}

async function getUserSettings(userId: string) {
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, userId))
    .limit(1);
  return {
    timezone: row?.timezone ?? "UTC",
    defaultEventDurationMin: row?.defaultEventDurationMin ?? 30,
    defaultCalendarId: row?.defaultCalendarId ?? "primary",
  };
}

async function answerQuery(
  userId: string,
  calendarId: string,
  timezone: string,
  range: { start: Date | string; end: Date | string },
): Promise<string> {
  const start = typeof range.start === "string" ? range.start : range.start.toISOString();
  const end = typeof range.end === "string" ? range.end : range.end.toISOString();
  const events = await listEvents(userId, calendarId, start, end);
  return formatQueryAnswer(events, timezone);
}

export async function parseInput(
  userId: string,
  input: ParseInput,
  channel: string,
): Promise<ParseOutcome> {
  const userSettings = await getUserSettings(userId);
  const referenceDate = new Date();

  // Image/PDF always goes straight to Claude — an uploaded file is never a
  // query, and the fast path can't read pixels.
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
      candidates: result.candidates,
      usedLlm: true,
      inputType: input.kind,
    };
  }

  const text = input.text.trim();
  const isLikelyQuery = looksLikeQuery(text);

  if (isLikelyQuery) {
    const range = fastPathQueryRange(text, referenceDate, userSettings.timezone);
    if (range) {
      const startedAt = Date.now();
      const answer = await answerQuery(
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
      return { intent: "query", candidates: [], answer, usedLlm: false, inputType: "text" };
    }
  } else {
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
      return { intent: "create", candidates: [candidate], usedLlm: false, inputType: "text" };
    }
  }

  // Fast path couldn't confidently handle it — fall back to Claude for both
  // intent classification and extraction in one call.
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
  if (result.intent === "query" && result.queryRange) {
    answer = await answerQuery(
      userId,
      userSettings.defaultCalendarId,
      userSettings.timezone,
      result.queryRange,
    );
  }

  logLlmCall({
    userId,
    channel,
    inputType: "text",
    usedLlm: true,
    model: result.model,
    intent: result.intent,
    candidateCount: result.candidates.length,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
  });

  return {
    intent: result.intent,
    candidates: result.candidates,
    answer,
    usedLlm: true,
    inputType: "text",
  };
}
