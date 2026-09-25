import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CalendarEvent } from "./google-calendar";

const UPCOMING: CalendarEvent[] = [
  { id: "g1", title: "Sahana Gymnastics", start: "2026-09-24T18:45:00-07:00", end: "2026-09-24T19:45:00-07:00" },
  { id: "h1", title: "Sasha - Hippity Hop", start: "2026-09-26T09:00:00-07:00", end: "2026-09-26T09:45:00-07:00" },
  { id: "f1", title: "Step one foods will ship on 1st", start: "2026-09-27", end: "2026-09-28" },
  { id: "g2", title: "Sasha Gymnastics", start: "2026-09-27T09:00:00-07:00", end: "2026-09-27T10:00:00-07:00" },
  { id: "h2", title: "Sahana - Hippity Hop", start: "2026-09-27T09:45:00-07:00", end: "2026-09-27T10:30:00-07:00" },
  { id: "s1", title: "Sahana swim at 6 30 pm", start: "2026-09-28T18:30:00-07:00", end: "2026-09-28T19:00:00-07:00" },
];

const extractWithClaude = vi.fn();
const selectAnswerEvents = vi.fn();
const listEvents = vi.fn();

vi.mock("./claude", () => ({
  extractWithClaude: (...args: unknown[]) => extractWithClaude(...args),
  selectAnswerEvents: (...args: unknown[]) => selectAnswerEvents(...args),
}));
vi.mock("./google-calendar", () => ({ listEvents: (...args: unknown[]) => listEvents(...args) }));
vi.mock("./user-settings", () => ({
  getUserSettings: async () => ({
    timezone: "America/Los_Angeles",
    defaultCalendarId: "cal-1",
    defaultEventDurationMin: 30,
  }),
}));
vi.mock("./llm-log", () => ({ logLlmCall: () => {} }));

const { parseInput } = await import("./parse");

const claudeResult = (overrides: object) => ({
  intent: "query",
  candidates: [],
  model: "test",
  promptTokens: 0,
  completionTokens: 0,
  latencyMs: 0,
  ...overrides,
});

const selection = (overrides: object) => ({
  eventIds: [],
  model: "test",
  promptTokens: 0,
  completionTokens: 0,
  latencyMs: 0,
  ...overrides,
});

describe("parseInput: answering a question by letting Claude pick events (default)", () => {
  beforeEach(() => {
    delete process.env.QUERY_ANSWER_STRATEGY;
    extractWithClaude.mockReset().mockResolvedValue(claudeResult({ searchQuery: "Sahana hippity hop" }));
    selectAnswerEvents.mockReset();
    listEvents.mockReset().mockResolvedValue(UPCOMING);
  });

  it("answers with the events Claude picked, in calendar order", async () => {
    selectAnswerEvents.mockResolvedValue(selection({ eventIds: ["e5"] }));

    const result = await parseInput("user-1", { kind: "text", text: "When is Sahana's hippity hop" }, "extension");

    expect(result.queryEvents?.map((e) => e.id)).toEqual(["h2"]);
    expect(result.answer).toContain("Sahana - Hippity Hop");
    expect(result.answerLead).toBeUndefined();
    const [question, events] = selectAnswerEvents.mock.calls[0];
    expect(question).toBe("When is Sahana's hippity hop");
    expect(events).toHaveLength(UPCOMING.length);
  });

  it("ignores ids that aren't in the list Claude was given", async () => {
    selectAnswerEvents.mockResolvedValue(selection({ eventIds: ["e99", "h2", "e2", "e0", " e5 "] }));

    const result = await parseInput("user-1", { kind: "text", text: "When is hippity hop" }, "extension");

    expect(result.queryEvents?.map((e) => e.id)).toEqual(["h1", "h2"]);
  });

  it("leads with Yes/No for a yes/no question, in the text answer too", async () => {
    selectAnswerEvents.mockResolvedValue(selection({ eventIds: ["e4", "e5"], yesNo: "no" }));

    const result = await parseInput("user-1", { kind: "text", text: "Am I free Sunday morning?" }, "extension");

    expect(result.answerLead).toBe("No.");
    expect(result.answer?.startsWith("No.\n")).toBe(true);
    expect(result.queryEvents?.map((e) => e.id)).toEqual(["g2", "h2"]);
  });

  it("answers a 'yes' with nothing to list as just 'Yes.'", async () => {
    selectAnswerEvents.mockResolvedValue(selection({ eventIds: [], yesNo: "yes" }));

    const result = await parseInput("user-1", { kind: "text", text: "Am I free Saturday afternoon?" }, "extension");

    expect(result.answer).toBe("Yes.");
    expect(result.queryEvents).toEqual([]);
  });

  it("says nothing matches when Claude picks nothing", async () => {
    selectAnswerEvents.mockResolvedValue(selection({ eventIds: [] }));

    const result = await parseInput("user-1", { kind: "text", text: "When is Sasha's swim?" }, "extension");

    expect(result.answer).toBe("Nothing on your calendar matches that.");
  });

  it("only fetches the question's own range when Claude found one", async () => {
    extractWithClaude.mockResolvedValue(
      claudeResult({ queryRange: { start: "2026-09-27T00:00:00-07:00", end: "2026-09-27T12:00:00-07:00" } }),
    );
    selectAnswerEvents.mockResolvedValue(selection({ eventIds: [] }));

    await parseInput("user-1", { kind: "text", text: "Am I free Sunday morning?" }, "extension");

    expect(listEvents.mock.calls[0].slice(2)).toEqual(["2026-09-27T00:00:00-07:00", "2026-09-27T12:00:00-07:00"]);
  });
});

describe("parseInput: keyword strategy (QUERY_ANSWER_STRATEGY=keyword)", () => {
  beforeEach(() => {
    process.env.QUERY_ANSWER_STRATEGY = "keyword";
    extractWithClaude.mockReset();
    selectAnswerEvents.mockReset();
    listEvents.mockReset().mockResolvedValue(UPCOMING);
  });

  it("answers with only the named event, not everything in the window", async () => {
    // Claude also guessed a wide range — the search query should still win.
    extractWithClaude.mockResolvedValue(
      claudeResult({
        searchQuery: "Sahana hippity hop",
        queryRange: { start: "2026-09-24T00:00:00-07:00", end: "2026-12-31T23:59:59-08:00" },
      }),
    );

    const result = await parseInput("user-1", { kind: "text", text: "When is Sahana's hippity hop" }, "extension");

    expect(result.intent).toBe("query");
    expect(result.queryEvents?.map((e) => e.id)).toEqual(["h2"]);
    expect(result.answer).toContain("Sahana - Hippity Hop");
    expect(result.answer).toContain("Sep 27");
    expect(result.answer).not.toContain("Sasha");
    expect(result.actions).toEqual([]);
  });

  it("searches forward from now when the question gives no date", async () => {
    extractWithClaude.mockResolvedValue(claudeResult({ searchQuery: "Sahana hippity hop" }));

    await parseInput("user-1", { kind: "text", text: "When is Sahana's hippity hop" }, "extension");

    const [, calendarId, start, end] = listEvents.mock.calls[0];
    expect(calendarId).toBe("cal-1");
    const spanDays = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    expect(spanDays).toBe(60);
  });

  it("says so when nothing matches, instead of listing unrelated events", async () => {
    extractWithClaude.mockResolvedValue(claudeResult({ searchQuery: "dentist" }));

    const result = await parseInput("user-1", { kind: "text", text: "when is my dentist appointment" }, "extension");

    expect(result.queryEvents).toEqual([]);
    expect(result.answer).toBe(`Couldn't find "dentist" on your calendar in the next 60 days.`);
    expect(selectAnswerEvents).not.toHaveBeenCalled();
  });
});
