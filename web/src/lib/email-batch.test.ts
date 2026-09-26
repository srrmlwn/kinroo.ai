import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CalendarEvent, EventAction, EventCandidate } from "./google-calendar";

const calendar = {
  listEvents: vi.fn(),
  insertEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
};
vi.mock("./google-calendar", async (importOriginal) => {
  const real = await importOriginal<typeof import("./google-calendar")>();
  return {
    isCandidateComplete: real.isCandidateComplete,
    listEvents: (...a: unknown[]) => calendar.listEvents(...a),
    insertEvent: (...a: unknown[]) => calendar.insertEvent(...a),
    updateEvent: (...a: unknown[]) => calendar.updateEvent(...a),
    deleteEvent: (...a: unknown[]) => calendar.deleteEvent(...a),
  };
});

const saved: unknown[] = [];
vi.mock("./db", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => ({
        returning: async () => {
          saved.push(v);
          return [{ id: "batch-1" }];
        },
      }),
    }),
    update: () => ({ set: (v: unknown) => ({ where: async () => saved.push(v) }) }),
  },
}));

const {
  applyEmailActions,
  editItem,
  findDuplicate,
  renderBatchSummary,
  undoFromLink,
  undoItem,
} = await import("./email-batch");

const TZ = "America/Los_Angeles";
const pta: EventCandidate = {
  title: "[Adams] PTA General Board Meeting",
  start: "2026-09-28T18:00:00-07:00",
  end: "2026-09-28T20:00:00-07:00",
  timezone: TZ,
};
const coffee: EventCandidate = {
  title: "[Adams] Coffee & Community",
  start: "2026-09-30T08:00:00-07:00",
  end: "2026-09-30T08:30:00-07:00",
  timezone: TZ,
};
const bigGive: EventCandidate = { title: "[Adams] The Big Give launch", start: "", end: "", timezone: TZ };
const create = (candidate: EventCandidate): EventAction => ({ type: "create", candidate });

beforeEach(() => {
  saved.length = 0;
  for (const fn of Object.values(calendar)) fn.mockReset();
  calendar.listEvents.mockResolvedValue([]);
  let n = 0;
  calendar.insertEvent.mockImplementation(async (_u: string, _c: string, cand: EventCandidate) => ({
    id: `ev${++n}`,
    title: cand.title,
    start: cand.start,
    end: cand.end,
    htmlLink: `https://calendar.google.com/event?eid=ev${n}`,
  }));
  calendar.updateEvent.mockImplementation(async (_u: string, _c: string, id: string, cand: EventCandidate) => ({
    id,
    title: cand.title,
    start: cand.start,
    end: cand.end,
  }));
  calendar.deleteEvent.mockResolvedValue(undefined);
});

describe("findDuplicate", () => {
  const existing: CalendarEvent[] = [
    { id: "x", title: "PTA General Board Meeting", start: "2026-09-28T18:00:00-07:00", end: "2026-09-28T20:00:00-07:00" },
  ];

  it("matches the same start with a title that ignores the [Adams] tag", () => {
    expect(findDuplicate(pta, existing)?.id).toBe("x");
  });

  it("doesn't match a different start time", () => {
    expect(findDuplicate({ ...pta, start: "2026-09-28T19:00:00-07:00" }, existing)).toBeUndefined();
  });

  it("doesn't match an unrelated event at the same time", () => {
    expect(findDuplicate({ ...pta, title: "Dentist" }, existing)).toBeUndefined();
  });
});

describe("applyEmailActions", () => {
  it("adds complete events, holds back ones missing a date, and labels what it adds", async () => {
    const batch = await applyEmailActions({
      userId: "u1",
      calendarId: "cal",
      fromAddress: "h@example.com",
      subject: "Your Upcoming Activities This Week",
      actions: [create(pta), create(coffee), create(bigGive)],
    });

    expect(batch.id).toBe("batch-1");
    expect(batch.items.map((i) => i.status)).toEqual(["applied", "applied", "needs-info"]);
    expect(calendar.insertEvent).toHaveBeenCalledTimes(2);
    expect(calendar.insertEvent.mock.calls[0][2].description).toBe(
      'Added by kinroo.ai from "Your Upcoming Activities This Week".',
    );
    expect(batch.items[0]).toMatchObject({ eventId: "ev1", htmlLink: "https://calendar.google.com/event?eid=ev1" });
  });

  it("skips an event that's already on the calendar", async () => {
    calendar.listEvents.mockResolvedValueOnce([
      { id: "existing", title: "PTA General Board Meeting", start: pta.start, end: pta.end },
    ]);
    const batch = await applyEmailActions({
      userId: "u1",
      calendarId: "cal",
      fromAddress: "h@example.com",
      subject: "",
      actions: [create(pta)],
    });
    expect(batch.items[0]).toMatchObject({ status: "duplicate", eventId: "existing" });
    expect(calendar.insertEvent).not.toHaveBeenCalled();
  });

  it("marks one failed write without stopping the rest", async () => {
    calendar.insertEvent.mockRejectedValueOnce(new Error("Calendar insert failed: 500"));
    const batch = await applyEmailActions({
      userId: "u1",
      calendarId: "cal",
      fromAddress: "h@example.com",
      subject: "",
      actions: [create(pta), create(coffee)],
    });
    expect(batch.items.map((i) => i.status)).toEqual(["failed", "applied"]);
  });

  it("applies cancellations and changes to existing events too", async () => {
    const original: CalendarEvent = { id: "e9", title: "Dentist", start: pta.start, end: pta.end };
    const batch = await applyEmailActions({
      userId: "u1",
      calendarId: "cal",
      fromAddress: "h@example.com",
      subject: "",
      actions: [
        { type: "delete", eventId: "e9", original },
        { type: "update", eventId: "e8", original: { ...original, id: "e8" }, candidate: coffee },
      ],
    });
    expect(calendar.deleteEvent).toHaveBeenCalledWith("u1", "cal", "e9");
    expect(calendar.updateEvent).toHaveBeenCalledWith("u1", "cal", "e8", coffee);
    expect(batch.items.map((i) => i.status)).toEqual(["applied", "applied"]);
  });
});

describe("undoItem", () => {
  it("deletes an added event", async () => {
    const item = await undoItem("u1", "cal", TZ, { n: 1, action: create(pta), status: "applied", eventId: "ev1" });
    expect(calendar.deleteEvent).toHaveBeenCalledWith("u1", "cal", "ev1");
    expect(item.status).toBe("undone");
  });

  it("re-creates a canceled event", async () => {
    const original: CalendarEvent = { id: "e9", title: "Dentist", start: pta.start, end: pta.end };
    const item = await undoItem("u1", "cal", TZ, {
      n: 1,
      action: { type: "delete", eventId: "e9", original },
      status: "applied",
      eventId: "e9",
    });
    expect(calendar.insertEvent.mock.calls[0][2]).toMatchObject({ title: "Dentist", start: pta.start });
    expect(item).toMatchObject({ status: "undone", eventId: "ev1" });
  });

  it("does nothing to an item that was never written", async () => {
    const item = { n: 3, action: create(bigGive), status: "needs-info" as const };
    expect(await undoItem("u1", "cal", TZ, item)).toBe(item);
    expect(calendar.deleteEvent).not.toHaveBeenCalled();
  });
});

describe("editItem", () => {
  it("moves an added event and keeps its length when only the start changes", async () => {
    const { item, error } = await editItem(
      "u1",
      "cal",
      { n: 1, action: create(pta), status: "applied", eventId: "ev1" },
      { start: "2026-09-28T19:00:00-07:00" },
      "",
    );
    expect(error).toBeUndefined();
    const sent = calendar.updateEvent.mock.calls[0][3] as EventCandidate;
    expect(sent.start).toBe("2026-09-28T19:00:00-07:00");
    expect(Date.parse(sent.end) - Date.parse(sent.start)).toBe(2 * 3600_000);
    expect(item.edited).toBe(true);
  });

  it("adds a held-back event once a reply gives it a time", async () => {
    const { item } = await editItem(
      "u1",
      "cal",
      { n: 3, action: create(bigGive), status: "needs-info" },
      { start: "2026-10-01T18:00:00-07:00" },
      "Weekly",
    );
    expect(item.status).toBe("applied");
    expect(calendar.insertEvent).toHaveBeenCalledTimes(1);
    const sent = calendar.insertEvent.mock.calls[0][2] as EventCandidate;
    expect(Date.parse(sent.end) - Date.parse(sent.start)).toBe(3600_000);
  });

  it("refuses to edit a cancellation", async () => {
    const original: CalendarEvent = { id: "e9", title: "Dentist", start: pta.start, end: pta.end };
    const { error } = await editItem(
      "u1",
      "cal",
      { n: 1, action: { type: "delete", eventId: "e9", original }, status: "applied", eventId: "e9" },
      { start: "2026-09-28T19:00:00-07:00" },
      "",
    );
    expect(error).toMatch(/cancellation/);
    expect(calendar.updateEvent).not.toHaveBeenCalled();
  });
});

describe("undoFromLink", () => {
  it("undoes every applied item for 'all', and is safe to repeat", async () => {
    const batch = {
      id: "b",
      userId: "u1",
      fromAddress: "h@example.com",
      subject: "",
      items: [
        { n: 1, action: create(pta), status: "applied" as const, eventId: "ev1" },
        { n: 2, action: create(coffee), status: "applied" as const, eventId: "ev2" },
        { n: 3, action: create(bigGive), status: "needs-info" as const },
      ],
    };
    expect(await undoFromLink(batch, "all", "cal", TZ)).toEqual({ undone: 2, failed: 0 });
    expect(await undoFromLink(batch, "all", "cal", TZ)).toEqual({ undone: 0, failed: 0 });
    expect(calendar.deleteEvent).toHaveBeenCalledTimes(2);
  });
});

describe("renderBatchSummary", () => {
  it("numbers items and gives each added event a remove and an edit link", () => {
    const text = renderBatchSummary(
      {
        id: "b",
        userId: "u1",
        fromAddress: "h@example.com",
        subject: "Weekly",
        items: [
          { n: 1, action: create(pta), status: "applied", eventId: "ev1", htmlLink: "https://cal/ev1" },
          { n: 2, action: create(coffee), status: "duplicate", eventId: "x" },
          { n: 3, action: create(bigGive), status: "needs-info" },
        ],
      },
      TZ,
      { undo: (i) => `https://kinroo.ai/email/undo?t=${i}` },
    );
    expect(text).toContain("1. Added: [Adams] PTA General Board Meeting — Mon, Sep 28, 6:00 PM–8:00 PM");
    expect(text).toContain("Remove: https://kinroo.ai/email/undo?t=1");
    expect(text).toContain("Edit in Google Calendar: https://cal/ev1");
    expect(text).toContain("3. [Adams] The Big Give launch — no date or time found");
    expect(text).toContain("2. Already on your calendar, not added again");
    expect(text).not.toContain("Undo everything");
  });
});
