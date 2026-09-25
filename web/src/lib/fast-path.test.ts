import { describe, it, expect } from "vitest";
import {
  looksLikeQuery,
  looksLikeRecurring,
  looksLikeModification,
  fastPathExtractCreate,
  fastPathQueryRange,
} from "./fast-path";

// Fixed reference: Friday 2026-09-18, noon Pacific.
const REF = new Date("2026-09-18T12:00:00-07:00");
const TZ = "America/Los_Angeles";

describe("looksLikeQuery", () => {
  it.each([
    "do I have plans Saturday?",
    "what's on Saturday?",
    "am I free tomorrow?",
    "is there anything Tuesday?",
    "any plans this weekend?",
    "What plans do i have this weekend",
    "anything on this weekend?",
    "show me my weekend",
    "when is my dentist appointment",
    "which days am I busy next week",
    "can I fit in a run tomorrow",
    "dinner with sam friday?",
  ])("treats %j as a query", (text) => {
    expect(looksLikeQuery(text)).toBe(true);
  });

  it.each([
    "doctor's appointment at 9am tomorrow",
    "schedule dentist next tuesday at 2pm",
    "team practice at 4pm on Saturday",
    "Do laundry Saturday at 10am",
    "When: Sunday, September 27, 3:00PM",
    "What: Maya's 3rd birthday party Sunday at 3pm",
    "Whole Foods run tomorrow at 5pm",
  ])("does not treat %j as a query", (text) => {
    expect(looksLikeQuery(text)).toBe(false);
  });
});

describe("looksLikeRecurring", () => {
  it.each([
    "team standup every Monday at 9am",
    "yoga class each Tuesday",
    "daily standup at 10am",
    "weekly 1:1 with sam",
    "recurring dentist checkup",
  ])("treats %j as recurring", (text) => {
    expect(looksLikeRecurring(text)).toBe(true);
  });

  it.each(["doctor's appointment at 9am tomorrow", "lunch with sam tomorrow 12:30pm"])(
    "does not treat %j as recurring",
    (text) => {
      expect(looksLikeRecurring(text)).toBe(false);
    },
  );
});

describe("looksLikeModification", () => {
  it.each([
    "cancel my dentist appointment tomorrow",
    "delete the team sync",
    "move my meeting to 4pm",
    "reschedule dentist to next Friday",
    "rename my 3pm call to Budget review",
  ])("treats %j as a modification", (text) => {
    expect(looksLikeModification(text)).toBe(true);
  });

  it.each(["doctor's appointment at 9am tomorrow", "lunch with sam tomorrow 12:30pm"])(
    "does not treat %j as a modification",
    (text) => {
      expect(looksLikeModification(text)).toBe(false);
    },
  );
});

describe("fastPathExtractCreate", () => {
  it("extracts title and resolves 'tomorrow' relative to the reference date", () => {
    const result = fastPathExtractCreate(
      "doctor's appointment at 9am tomorrow",
      REF,
      TZ,
      30,
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("doctor's appointment");
    // 9am Pacific on 2026-09-19 (the day after the Sept 18 reference).
    expect(result?.start).toBe("2026-09-19T16:00:00.000Z");
  });

  it("defaults duration when none is stated", () => {
    const result = fastPathExtractCreate("lunch with sam tomorrow 12:30pm", REF, TZ, 30);
    expect(result).not.toBeNull();
    const start = new Date(result!.start).getTime();
    const end = new Date(result!.end).getTime();
    expect(end - start).toBe(30 * 60_000);
  });

  it("resolves 'next tuesday' forward from the reference date", () => {
    const result = fastPathExtractCreate("dentist next tuesday at 2pm", REF, TZ, 30);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("dentist");
    expect(new Date(result!.start).getUTCDate()).toBe(22); // 2026-09-22 is the next Tuesday after Fri 9/18
  });

  it("extracts the title when the date phrase comes first", () => {
    const result = fastPathExtractCreate("tomorrow at 9am doctor appointment", REF, TZ, 30);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("doctor appointment");
  });

  it("strips a leading comma left over from the matched span", () => {
    const result = fastPathExtractCreate("meeting, tuesday at 3pm", REF, TZ, 30);
    expect(result).not.toBeNull();
    expect(result?.title.startsWith(",")).toBe(false);
  });

  it("returns null when there's no date/time to anchor on (defers to the LLM)", () => {
    expect(fastPathExtractCreate("call mom", REF, TZ, 30)).toBeNull();
  });

  it("returns null when the leftover title is too short to be confident", () => {
    // The whole string is consumed by the date/time match, leaving nothing.
    expect(fastPathExtractCreate("tomorrow at 9am", REF, TZ, 30)).toBeNull();
  });

  it("extracts a trailing 'at <place>' as location, not title", () => {
    const result = fastPathExtractCreate(
      "Harinii's waxing appointment on Sunday at 1pm at Waxin the City Ballard",
      REF,
      TZ,
      30,
    );
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Harinii's waxing appointment");
    expect(result?.location).toBe("Waxin the City Ballard");
  });

  it("extracts a trailing '@ <place>' as location", () => {
    const result = fastPathExtractCreate("dinner tomorrow at 7pm @ Cafe Luna", REF, TZ, 30);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("dinner");
    expect(result?.location).toBe("Cafe Luna");
  });

  it("returns null for text copied off an event page (headings, buttons, address)", () => {
    expect(
      fastPathExtractCreate(
        "Event details   Sunday, September 27, 2026 3:00PM - 4:30PM  Add to calendar Tumbles Ballard 5680 24th Ave NW Seattle, WA 98107  View Map",
        REF,
        TZ,
        30,
      ),
    ).toBeNull();
  });

  it("returns null when the leftover title contains a street address", () => {
    expect(fastPathExtractCreate("party Saturday 3pm 5680 24th Ave NW", REF, TZ, 30)).toBeNull();
  });

  it("returns null when the leftover title contains a state and ZIP", () => {
    expect(fastPathExtractCreate("party Saturday 3pm Seattle, WA 98107", REF, TZ, 30)).toBeNull();
  });

  it("returns null when the leftover title is too long to be a typed title", () => {
    expect(
      fastPathExtractCreate(
        "tomorrow at 9am please remember to bring the signed permission slip and snacks for everyone",
        REF,
        TZ,
        30,
      ),
    ).toBeNull();
  });

  it("still handles a short typed phrase with an 'at <place>' location", () => {
    const result = fastPathExtractCreate("lunch tomorrow at noon at 5680 24th Ave NW", REF, TZ, 30);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("lunch");
  });

  it("leaves location undefined when there's no trailing 'at <place>'", () => {
    const result = fastPathExtractCreate("doctor's appointment at 9am tomorrow", REF, TZ, 30);
    expect(result).not.toBeNull();
    expect(result?.location).toBeUndefined();
  });
});

describe("fastPathQueryRange", () => {
  it("resolves a bare weekday to that whole day in the given timezone, not the test runner's", () => {
    const range = fastPathQueryRange("Saturday", REF, TZ);
    expect(range).not.toBeNull();
    // Midnight-to-end-of-day Saturday 2026-09-19 in America/Los_Angeles
    // (PDT, UTC-7) as UTC instants — asserted directly rather than via
    // .getHours(), which reads in the *test runner's* local timezone and
    // would pass or fail depending on where the suite happens to run.
    expect(range?.start.toISOString()).toBe("2026-09-19T07:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-09-20T06:59:59.999Z");
  });

  it("resolves a specific time to a narrow window, not the whole day", () => {
    const range = fastPathQueryRange("3pm tomorrow", REF, TZ);
    expect(range).not.toBeNull();
    const spanMinutes = (range!.end.getTime() - range!.start.getTime()) / 60_000;
    expect(spanMinutes).toBeLessThan(120);
  });

  it("covers both Saturday and Sunday for 'this weekend'", () => {
    const range = fastPathQueryRange("What plans do i have this weekend", REF, TZ);
    expect(range).not.toBeNull();
    // Sat 2026-09-19 00:00 through Sun 2026-09-20 23:59:59.999 Pacific.
    expect(range?.start.toISOString()).toBe("2026-09-19T07:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-09-21T06:59:59.999Z");
  });

  it.each([
    "what's on Sunday",
    "What plans do i have this weekend",
    "do I have anything tomorrow?",
    "show me my schedule for Saturday",
    "anything on Tuesday",
  ])("answers the plain listing question %j without Claude", (text) => {
    expect(fastPathQueryRange(text, REF, TZ)).not.toBeNull();
  });

  it.each([
    "am I free Sunday morning?",
    "does Sasha have anything Monday",
    "what's my first thing Sunday",
    "anything after 6pm this week",
    "when is Sahana's gymnastics on Friday",
  ])("defers %j to Claude, since it asks for part of the range", (text) => {
    expect(fastPathQueryRange(text, REF, TZ)).toBeNull();
  });

  it("returns null when there's nothing to anchor a range on", () => {
    expect(fastPathQueryRange("do I have anything going on", REF, TZ)).toBeNull();
  });
});
