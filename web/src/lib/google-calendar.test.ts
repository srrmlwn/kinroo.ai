import { describe, it, expect } from "vitest";
import { isCandidateComplete } from "./google-calendar";

const complete = {
  title: "Maya's 3rd Birthday",
  start: "2026-09-27T15:00:00-07:00",
  end: "2026-09-27T16:30:00-07:00",
};

describe("isCandidateComplete", () => {
  it("accepts a candidate with a title, start, and end", () => {
    expect(isCandidateComplete(complete)).toBe(true);
  });

  it("rejects a candidate the parse couldn't find a date for", () => {
    expect(isCandidateComplete({ ...complete, start: "", end: "" })).toBe(false);
  });

  it("rejects a candidate with no title, or only whitespace", () => {
    expect(isCandidateComplete({ ...complete, title: "" })).toBe(false);
    expect(isCandidateComplete({ ...complete, title: "   " })).toBe(false);
  });
});
