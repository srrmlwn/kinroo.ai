import { describe, it, expect } from "vitest";
import { extractAddresses, parseSenderAddress, parseRecipientAlias, classifyReply } from "./email-inbound";

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
