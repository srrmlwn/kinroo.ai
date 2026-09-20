import { describe, it, expect } from "vitest";
import { isFullIsoDatetime } from "./parse";

describe("isFullIsoDatetime", () => {
  it.each([
    "2026-09-21T09:00:00Z",
    "2026-09-21T09:00:00.000Z",
    "2026-09-21T09:00:00-07:00",
    "2026-09-21T09:00:00.123+05:30",
  ])("accepts %j", (value) => {
    expect(isFullIsoDatetime(value)).toBe(true);
  });

  it.each([
    "2026-09-21",
    "2026-09-21T09:00:00",
    "tomorrow",
    "",
    "09/21/2026 9:00am",
  ])("rejects %j (missing time or offset, or not a date at all)", (value) => {
    expect(isFullIsoDatetime(value)).toBe(false);
  });
});
