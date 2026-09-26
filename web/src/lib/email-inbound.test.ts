import { describe, it, expect } from "vitest";
import {
  extractAddresses,
  parseSenderAddress,
  parseRecipientAlias,
  classifyReply,
  isSenderAuthenticated,
  isDkimAligned,
  stripQuotedReply,
} from "./email-inbound";

describe("extractAddresses", () => {
  it("extracts a bare address", () => {
    expect(extractAddresses("add@mail.kinroo.ai")).toEqual(["add@mail.kinroo.ai"]);
  });

  it("extracts an address from a display-name header", () => {
    expect(extractAddresses("Jane Doe <jane@example.com>")).toEqual(["jane@example.com"]);
  });

  it("extracts multiple comma-separated addresses and lowercases them", () => {
    expect(extractAddresses("Add <Add@Mail.Kinroo.AI>, jane@example.com")).toEqual([
      "add@mail.kinroo.ai",
      "jane@example.com",
    ]);
  });
});

describe("parseSenderAddress", () => {
  it("returns the first address found", () => {
    expect(parseSenderAddress("Jane Doe <jane@example.com>")).toBe("jane@example.com");
  });

  it("returns null when nothing looks like an address", () => {
    expect(parseSenderAddress("not an address")).toBeNull();
  });
});

describe("parseRecipientAlias", () => {
  it("recognizes the add@ alias", () => {
    expect(parseRecipientAlias("add@mail.kinroo.ai")).toEqual({ kind: "add" });
  });

  it("recognizes a confirm+<id>@ alias and extracts the id", () => {
    expect(parseRecipientAlias("confirm+abc-123@mail.kinroo.ai")).toEqual({
      kind: "confirm",
      pendingActionId: "abc-123",
    });
  });

  it("finds the matching alias among several recipients", () => {
    expect(parseRecipientAlias("Jane <jane@example.com>, Add <add@mail.kinroo.ai>")).toEqual({
      kind: "add",
    });
  });

  it("returns null when no recipient matches either alias", () => {
    expect(parseRecipientAlias("jane@example.com")).toBeNull();
  });
});

describe("classifyReply", () => {
  it.each(["Yes", "yep, please add it", "confirm", "Sure thing"])(
    "classifies %j as yes",
    (body) => {
      expect(classifyReply(body)).toBe("yes");
    },
  );

  it.each(["No", "nope", "cancel that", "don't add it"])("classifies %j as no", (body) => {
    expect(classifyReply(body)).toBe("no");
  });

  it("classifies an unrelated reply as unclear", () => {
    expect(classifyReply("wait, what time is that again?")).toBe("unclear");
  });

  it("only looks at the first non-empty line, ignoring quoted history", () => {
    expect(classifyReply("\n\nYes\n\nOn Sep 20, kinroo.ai wrote:\n> cancel")).toBe("yes");
  });
});

describe("isSenderAuthenticated", () => {
  it("passes on SPF pass alone", () => {
    expect(isSenderAuthenticated("pass", "none")).toBe(true);
  });

  it("passes on a DKIM pass alone", () => {
    expect(isSenderAuthenticated("fail", "{@example.com : pass}")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSenderAuthenticated("PASS", null)).toBe(true);
    expect(isSenderAuthenticated(null, "{@example.com : PASS}")).toBe(true);
  });

  it("fails when both SPF and DKIM fail", () => {
    expect(isSenderAuthenticated("fail", "{@example.com : fail}")).toBe(false);
  });

  it("fails when both are missing", () => {
    expect(isSenderAuthenticated(null, null)).toBe(false);
  });

  it("treats softfail/neutral/none as not passing", () => {
    expect(isSenderAuthenticated("softfail", "none")).toBe(false);
    expect(isSenderAuthenticated("neutral", null)).toBe(false);
  });
});

describe("parseRecipientAlias: summary replies", () => {
  it("recognizes a reply to an auto-apply summary", () => {
    expect(parseRecipientAlias("batch+3f2c-11@mail.kinroo.ai")).toEqual({ kind: "batch", batchId: "3f2c-11" });
  });
});

describe("isDkimAligned", () => {
  it("accepts a passing signature from the sender's own domain", () => {
    expect(isDkimAligned("{@gmail.com : pass}", "harinii@gmail.com")).toBe(true);
  });

  it("accepts a parent or subdomain of the sender's domain", () => {
    expect(isDkimAligned("{@example.com : pass}", "a@mail.example.com")).toBe(true);
    expect(isDkimAligned("{@mail.example.com : pass}", "a@example.com")).toBe(true);
  });

  it("rejects a passing signature from some other domain (a relay or list)", () => {
    expect(isDkimAligned("{@sendgrid.net : pass}", "harinii@gmail.com")).toBe(false);
  });

  it("rejects a failing signature, and no signature at all", () => {
    expect(isDkimAligned("{@gmail.com : fail}", "harinii@gmail.com")).toBe(false);
    expect(isDkimAligned(null, "harinii@gmail.com")).toBe(false);
  });

  it("finds the aligned pass among several signatures", () => {
    expect(isDkimAligned("{@sendgrid.net : pass, @gmail.com : pass}", "harinii@gmail.com")).toBe(true);
  });
});

describe("stripQuotedReply", () => {
  it("keeps only what was typed above the quoted summary", () => {
    const body = "1 is at 7pm, remove 2\n\nOn Sat, Sep 26, 2026 at 9:00 AM kinroo.ai <kinroo@kinroo.ai> wrote:\n> On your calendar:\n> 1. Added: PTA";
    expect(stripQuotedReply(body)).toBe("1 is at 7pm, remove 2");
  });

  it("stops at a '>' quote even without an attribution line", () => {
    expect(stripQuotedReply("remove 3\n> 3. Added: Coffee")).toBe("remove 3");
  });

  it("returns an empty string for a reply with nothing typed", () => {
    expect(stripQuotedReply("\n\n> quoted only")).toBe("");
  });
});
