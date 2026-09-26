import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// A real "upcoming activities" digest email (school PTA platform): three
// dated events, then a week of announcements whose dates are only posting
// times — and a headline, "Change to Volunteer Process!", that reads like
// an edit request.
const DIGEST = fs.readFileSync(path.join(__dirname, "__fixtures__/activity-digest-email.txt"), "utf8");

const extractWithClaude = vi.fn();
vi.mock("./claude", () => ({
  extractWithClaude: (...args: unknown[]) => extractWithClaude(...args),
  selectAnswerEvents: vi.fn(),
}));
vi.mock("./google-calendar", () => ({ listEvents: async () => [] }));
vi.mock("./user-settings", () => ({
  getUserSettings: async () => ({ timezone: "America/Los_Angeles", defaultCalendarId: "cal", defaultEventDurationMin: 30 }),
}));
vi.mock("./llm-log", () => ({ logLlmCall: () => {} }));

const { parseInput, isDocumentText } = await import("./parse");

const TZ = "America/Los_Angeles";
const candidate = (title: string, start: string, end: string) => ({ title, start, end, timezone: TZ });

beforeEach(() => {
  extractWithClaude.mockReset().mockResolvedValue({
    intent: "create",
    candidates: [
      candidate("[Adams] PTA General Board Meeting", "2026-09-28T18:00:00-07:00", "2026-09-28T20:00:00-07:00"),
      candidate("[Adams] Coffee & Community", "2026-09-30T08:00:00-07:00", "2026-09-30T08:30:00-07:00"),
      candidate("[Adams] The Big Give launch", "", ""),
    ],
    model: "test",
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
  });
});

describe("long pasted text is parsed as a document", () => {
  it("treats the digest email as a document, not a typed request", () => {
    expect(isDocumentText(DIGEST)).toBe(true);
    expect(isDocumentText("cancel my dentist appointment tomorrow")).toBe(false);
  });

  it("asks Claude for every event, always as creates, and keeps all of them", async () => {
    const result = await parseInput("u1", { kind: "text", text: DIGEST }, "email");

    const [input, opts] = extractWithClaude.mock.calls[0];
    expect(input).toEqual({ kind: "text", text: DIGEST.trim() });
    expect(opts.forceCreateIntent).toBe(true);
    expect(result.intent).toBe("create");
    expect(result.actions.map((a) => a.type)).toEqual(["create", "create", "create"]);
    expect(result.inputType).toBe("text");
  });

  it("isn't read as an edit even though it contains the word 'Change'", async () => {
    // Claude classifying it "update" is exactly what forceCreateIntent rules
    // out: a document's intent is always create.
    extractWithClaude.mockResolvedValueOnce({
      intent: "create",
      candidates: [],
      model: "t",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
    });
    const result = await parseInput("u1", { kind: "text", text: DIGEST }, "extension");
    expect(result.intent).toBe("create");
    expect(extractWithClaude.mock.calls[0][1].forceCreateIntent).toBe(true);
  });

  it("still sends short typed text through the typed-request path", async () => {
    extractWithClaude.mockResolvedValueOnce({
      intent: "delete",
      candidates: [],
      searchQuery: "dentist",
      model: "t",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
    });
    await parseInput("u1", { kind: "text", text: "cancel my dentist appointment" }, "extension");
    expect(extractWithClaude.mock.calls[0][1].forceCreateIntent).toBe(false);
  });
});
