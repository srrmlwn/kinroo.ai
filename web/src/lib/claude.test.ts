import { describe, it, expect } from "vitest";
import { toIcalUtc } from "./claude";

describe("toIcalUtc", () => {
  it("converts an ISO 8601 datetime with UTC offset to iCalendar UTC basic format", () => {
    expect(toIcalUtc("2026-11-26T18:00:00-08:00")).toBe("20261127T020000Z");
  });

  it("converts a UTC ISO datetime unchanged in instant", () => {
    expect(toIcalUtc("2026-12-10T20:00:00Z")).toBe("20261210T200000Z");
  });
});
