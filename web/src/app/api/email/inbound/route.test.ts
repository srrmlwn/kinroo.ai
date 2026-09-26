import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventAction, EventCandidate } from "@/lib/google-calendar";
import { emailBatches, emailIdentities, pendingEmailActions } from "@/lib/db/schema";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.EMAIL_INGEST_DOMAIN = "mail.kinroo.ai";
process.env.EMAIL_FROM_DOMAIN = "kinroo.ai";

const TZ = "America/Los_Angeles";
const pta: EventCandidate = {
  title: "PTA General Board Meeting",
  start: "2026-09-28T18:00:00-07:00",
  end: "2026-09-28T20:00:00-07:00",
  timezone: TZ,
};
const coffee: EventCandidate = {
  title: "Coffee & Community",
  start: "2026-09-30T08:00:00-07:00",
  end: "2026-09-30T08:30:00-07:00",
  timezone: TZ,
};

// --- fakes ---------------------------------------------------------------
const state = {
  settings: { timezone: TZ, defaultEventDurationMin: 30, defaultCalendarId: "cal", emailAutoApply: true, extensionAutoApply: false },
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  batchRow: null as null | Record<string, unknown>,
  sent: [] as Array<{ to: string; subject: string; text: string; replyTo?: string }>,
  parseActions: [] as EventAction[],
};

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === emailIdentities ? [{ userId: "u1" }] : table === emailBatches && state.batchRow ? [state.batchRow] : [],
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          state.inserts.push({ table, values });
          const id = table === emailBatches ? "11111111-2222-3333-4444-555555555555" : "pending-1";
          if (table === emailBatches) state.batchRow = { id, ...values };
          return [{ id }];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === emailBatches && state.batchRow) state.batchRow = { ...state.batchRow, ...values };
        },
      }),
    }),
  },
}));
vi.mock("@/lib/user-settings", () => ({ getUserSettings: async () => state.settings }));
vi.mock("@/lib/parse", () => ({
  parseInput: async () => ({ intent: "create", actions: state.parseActions, usedLlm: true, inputType: "text" }),
}));
vi.mock("@/lib/llm-log", () => ({ logLlmCall: () => {} }));
vi.mock("@/lib/email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email")>();
  return { ...real, sendEmail: async (msg: (typeof state.sent)[number]) => void state.sent.push(msg) };
});

const calendar = { listEvents: vi.fn(), insertEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn() };
vi.mock("@/lib/google-calendar", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google-calendar")>();
  return {
    ...real,
    listEvents: (...a: unknown[]) => calendar.listEvents(...a),
    insertEvent: (...a: unknown[]) => calendar.insertEvent(...a),
    updateEvent: (...a: unknown[]) => calendar.updateEvent(...a),
    deleteEvent: (...a: unknown[]) => calendar.deleteEvent(...a),
  };
});
const interpretSummaryReply = vi.fn();
vi.mock("@/lib/claude", () => ({ interpretSummaryReply: (...a: unknown[]) => interpretSummaryReply(...a) }));

const { POST } = await import("./route");

function inbound(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return POST(new Request("https://kinroo.ai/api/email/inbound", { method: "POST", body: form }));
}

beforeEach(() => {
  state.settings.emailAutoApply = true;
  state.inserts = [];
  state.batchRow = null;
  state.sent = [];
  state.parseActions = [
    { type: "create", candidate: pta },
    { type: "create", candidate: coffee },
  ];
  for (const fn of Object.values(calendar)) fn.mockReset();
  calendar.listEvents.mockResolvedValue([]);
  let n = 0;
  calendar.insertEvent.mockImplementation(async (_u: string, _c: string, c: EventCandidate) => ({
    id: `ev${++n}`,
    title: c.title,
    start: c.start,
    end: c.end,
    htmlLink: `https://calendar.google.com/ev${n}`,
  }));
  calendar.updateEvent.mockImplementation(async (_u: string, _c: string, id: string, c: EventCandidate) => ({ id, ...c }));
  calendar.deleteEvent.mockResolvedValue(undefined);
  interpretSummaryReply.mockReset();
});

const fromHarinii = { from: "Harinii <harinii@gmail.com>", to: "add@mail.kinroo.ai", subject: "Weekly", text: "..." };

describe("inbound email: auto-apply", () => {
  it("adds every event and replies with a numbered summary, undo links, and a batch reply-to", async () => {
    await inbound({ ...fromHarinii, SPF: "pass", dkim: "{@gmail.com : pass}" });

    expect(calendar.insertEvent).toHaveBeenCalledTimes(2);
    expect(state.inserts.find((i) => i.table === pendingEmailActions)).toBeUndefined();
    expect(state.sent).toHaveLength(1);
    const [mail] = state.sent;
    expect(mail.to).toBe("harinii@gmail.com");
    expect(mail.subject).toBe("2 changes made: Weekly");
    expect(mail.replyTo).toBe("batch+11111111-2222-3333-4444-555555555555@mail.kinroo.ai");
    expect(mail.text).toContain("1. Added: PTA General Board Meeting");
    expect(mail.text).toMatch(/Remove: https:\/\/kinroo\.ai\/email\/undo\?t=\S+/);
    expect(mail.text).toContain("Undo everything from this email:");
  });

  it("falls back to reply-to-confirm when DKIM isn't from the sender's domain", async () => {
    await inbound({ ...fromHarinii, SPF: "pass", dkim: "{@sendgrid.net : pass}" });

    expect(calendar.insertEvent).not.toHaveBeenCalled();
    expect(state.inserts.some((i) => i.table === pendingEmailActions)).toBe(true);
    expect(state.sent[0].subject).toMatch(/^Confirm:/);
  });

  it("falls back to reply-to-confirm when email auto-apply is turned off", async () => {
    state.settings.emailAutoApply = false;
    await inbound({ ...fromHarinii, SPF: "pass", dkim: "{@gmail.com : pass}" });

    expect(calendar.insertEvent).not.toHaveBeenCalled();
    expect(state.sent[0].subject).toMatch(/^Confirm:/);
  });
});

describe("inbound email: ambiguous edits", () => {
  it("changes nothing and asks which one when a cancel matches several events", async () => {
    const dentist = (id: string, day: string) => ({
      id,
      title: "Dentist",
      start: `2026-10-${day}T09:00:00-07:00`,
      end: `2026-10-${day}T10:00:00-07:00`,
    });
    state.parseActions = [
      { type: "delete", eventId: "d1", original: dentist("d1", "02") },
      { type: "delete", eventId: "d2", original: dentist("d2", "09") },
    ];
    await inbound({ ...fromHarinii, SPF: "pass", dkim: "{@gmail.com : pass}" });

    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(state.sent[0].text).toContain("That matches 2 events, so nothing was changed");
    expect(state.sent[0].text).toContain("1. Dentist — Fri, Oct 2, 9:00 AM–10:00 AM");
  });
});

describe("inbound email: replies to a summary", () => {
  it("applies '1 is at 7pm, remove 2' and sends an updated summary", async () => {
    await inbound({ ...fromHarinii, SPF: "pass", dkim: "{@gmail.com : pass}" });
    state.sent = [];
    interpretSummaryReply.mockResolvedValue({
      operations: [
        { item: 1, op: "change", start: "2026-09-28T19:00:00-07:00" },
        { item: 2, op: "undo" },
      ],
      unclear: false,
      model: "test",
      promptTokens: 0,
      completionTokens: 0,
    });

    await inbound({
      from: "harinii@gmail.com",
      to: "batch+11111111-2222-3333-4444-555555555555@mail.kinroo.ai",
      subject: "Re: 2 changes made: Weekly",
      text: "1 is at 7pm, remove 2\n\nOn Sat, Sep 26, 2026 kinroo.ai wrote:\n> On your calendar:",
      SPF: "pass",
      dkim: "{@gmail.com : pass}",
    });

    expect(interpretSummaryReply.mock.calls[0][0]).toBe("1 is at 7pm, remove 2");
    expect(calendar.updateEvent).toHaveBeenCalledWith("u1", "cal", "ev1", expect.objectContaining({ start: "2026-09-28T19:00:00-07:00" }));
    expect(calendar.deleteEvent).toHaveBeenCalledWith("u1", "cal", "ev2");
    const [mail] = state.sent;
    expect(mail.text).toContain("1: updated.");
    expect(mail.text).toContain("2: done.");
    expect(mail.text).toContain("1. Added: PTA General Board Meeting — Mon, Sep 28, 7:00 PM–9:00 PM (edited)");
    expect(mail.text).toContain("2. Removed: Coffee & Community");
  });

  it("says so, and changes nothing, when the reply can't be mapped to an item", async () => {
    await inbound({ ...fromHarinii, SPF: "pass", dkim: "{@gmail.com : pass}" });
    state.sent = [];
    interpretSummaryReply.mockResolvedValue({ operations: [], unclear: true, model: "t", promptTokens: 0, completionTokens: 0 });

    await inbound({
      from: "harinii@gmail.com",
      to: "batch+11111111-2222-3333-4444-555555555555@mail.kinroo.ai",
      subject: "Re: Weekly",
      text: "make it better",
      SPF: "pass",
      dkim: "{@gmail.com : pass}",
    });

    expect(calendar.updateEvent).not.toHaveBeenCalled();
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(state.sent[0].text).toMatch(/couldn't tell what to change/);
  });
});
