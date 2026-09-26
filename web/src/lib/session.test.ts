import { describe, it, expect } from "vitest";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
const {
  createUndoLinkToken,
  verifyUndoLinkToken,
  createSessionToken,
  verifySessionToken,
  createHandoffToken,
  verifyHandoffToken,
} = await import("./session");

describe("undo link tokens", () => {
  it("round-trips the batch, item, and user", async () => {
    const token = await createUndoLinkToken({ userId: "u1", batchId: "b1", item: 2 });
    expect(await verifyUndoLinkToken(token)).toEqual({ userId: "u1", batchId: "b1", item: 2 });
    const all = await createUndoLinkToken({ userId: "u1", batchId: "b1", item: "all" });
    expect((await verifyUndoLinkToken(all))?.item).toBe("all");
  });

  it("rejects a tampered token", async () => {
    const token = await createUndoLinkToken({ userId: "u1", batchId: "b1", item: 2 });
    expect(await verifyUndoLinkToken(token.slice(0, -2) + "xx")).toBeNull();
  });

  it("can't be used as a session token, and a session token can't be used as an undo link", async () => {
    const undo = await createUndoLinkToken({ userId: "u1", batchId: "b1", item: 2 });
    const session = await createSessionToken("u1");
    expect(await verifySessionToken(undo)).toBeNull();
    expect(await verifyUndoLinkToken(session)).toBeNull();
    expect(await verifySessionToken(session)).toBe("u1");
  });

  it("a settings handoff token can't be used as a session token either", async () => {
    const handoff = await createHandoffToken("u1");
    expect(await verifySessionToken(handoff)).toBeNull();
    expect(await verifyHandoffToken(handoff)).toBe("u1");
  });
});
