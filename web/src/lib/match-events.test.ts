import { describe, it, expect } from "vitest";
import { findMatchingEvents, findBestMatchingEvents } from "./match-events";
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

const KIDS: CalendarEvent[] = [
  { id: "g1", title: "Sahana Gymnastics", start: "2026-09-24T18:45:00-07:00", end: "2026-09-24T19:45:00-07:00" },
  { id: "h1", title: "Sasha - Hippity Hop", start: "2026-09-26T09:00:00-07:00", end: "2026-09-26T09:45:00-07:00" },
  { id: "g2", title: "Sasha Gymnastics", start: "2026-09-27T09:00:00-07:00", end: "2026-09-27T10:00:00-07:00" },
  { id: "h2", title: "Sahana - Hippity Hop", start: "2026-09-27T09:45:00-07:00", end: "2026-09-27T10:30:00-07:00" },
  { id: "h3", title: "Sahana - Hippity Hop", start: "2026-10-04T09:45:00-07:00", end: "2026-10-04T10:30:00-07:00" },
];

describe("findBestMatchingEvents", () => {
  it("returns only the named child's class, not the sibling's or other classes of the same child", () => {
    const matches = findBestMatchingEvents(KIDS, "sahana's hippity hop");
    expect(matches.map((e) => e.id)).toEqual(["h2", "h3"]);
  });

  it("returns both kids' classes when the question doesn't say whose", () => {
    const matches = findBestMatchingEvents(KIDS, "hippity hop");
    expect(matches.map((e) => e.id)).toEqual(["h1", "h2", "h3"]);
  });

  it("returns nothing when no title shares a word with the query", () => {
    expect(findBestMatchingEvents(KIDS, "dentist")).toEqual([]);
  });

  it("returns nothing (not every event) when the query is all stopwords", () => {
    expect(findBestMatchingEvents(KIDS, "the event")).toEqual([]);
  });
});
