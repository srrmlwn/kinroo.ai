import { describe, it, expect } from "vitest";
import { findMatchingEvents } from "./match-events";
import type { CalendarEvent } from "./google-calendar";

const EVENTS: CalendarEvent[] = [
  { id: "1", title: "Dentist checkup", start: "2026-09-21T09:00:00Z", end: "2026-09-21T09:30:00Z" },
  { id: "2", title: "Team sync", start: "2026-09-21T10:00:00Z", end: "2026-09-21T10:30:00Z" },
  { id: "3", title: "Lunch with Sam", start: "2026-09-21T12:00:00Z", end: "2026-09-21T13:00:00Z" },
];

describe("findMatchingEvents", () => {
  it("finds the event whose title shares a keyword with the query", () => {
    const matches = findMatchingEvents(EVENTS, "dentist appointment");
    expect(matches.map((e) => e.id)).toEqual(["1"]);
  });

  it("ranks events with more overlapping words first", () => {
    const matches = findMatchingEvents(EVENTS, "team sync meeting");
    expect(matches[0]?.id).toBe("2");
  });

  it("returns an empty array when nothing matches", () => {
    expect(findMatchingEvents(EVENTS, "yoga class")).toEqual([]);
  });

  it("falls back to returning events unfiltered when the query is all stopwords", () => {
    const matches = findMatchingEvents(EVENTS, "the meeting");
    expect(matches.length).toBe(EVENTS.length);
  });

  it("respects the limit", () => {
    const matches = findMatchingEvents(EVENTS, "the meeting", 2);
    expect(matches.length).toBe(2);
  });
});
