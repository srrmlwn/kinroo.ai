import { describe, it, expect } from "vitest";
import { formatQueryAnswer } from "./format-answer";

describe("formatQueryAnswer", () => {
  it("returns a plain message when there are no events", () => {
    expect(formatQueryAnswer([], "America/Los_Angeles")).toBe("Nothing found for that time.");
  });

  it("lists each event with its title and time", () => {
    const answer = formatQueryAnswer(
      [
        { id: "1", title: "Soccer practice", start: "2026-09-19T23:00:00.000Z", end: "2026-09-20T00:00:00.000Z" },
        { id: "2", title: "Dinner with Sam", start: "2026-09-20T02:00:00.000Z", end: "2026-09-20T03:00:00.000Z" },
      ],
      "America/Los_Angeles",
    );
    const lines = answer.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Soccer practice");
    expect(lines[1]).toContain("Dinner with Sam");
  });

  it("formats an all-day event (date only, no time component) without a time of day", () => {
    const answer = formatQueryAnswer(
      [{ id: "1", title: "Company holiday", start: "2026-09-20", end: "2026-09-21" }],
      "America/Los_Angeles",
    );
    expect(answer).toContain("Company holiday");
    expect(answer).not.toMatch(/\d+:\d{2}/); // no HH:MM in a date-only event
  });
});
