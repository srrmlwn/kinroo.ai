import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EmailBatch } from "@/lib/email-batch";

const TZ = "America/Los_Angeles";
let batch: EmailBatch;
const claims = { userId: "u1", batchId: "b1", item: "all" as number | "all" };
const deleteEvent = vi.fn();

vi.mock("@/lib/session", () => ({ verifyUndoLinkToken: async (t: string) => (t === "good" ? claims : null) }));
vi.mock("@/lib/user-settings", () => ({ getUserSettings: async () => ({ timezone: TZ, defaultCalendarId: "cal" }) }));
vi.mock("@/lib/db", () => ({ db: { update: () => ({ set: () => ({ where: async () => {} }) }) } }));
vi.mock("@/lib/google-calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-calendar")>()),
  deleteEvent: (...a: unknown[]) => deleteEvent(...a),
}));
vi.mock("@/lib/email-batch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-batch")>()),
  loadBatch: async () => batch,
}));

const { default: UndoPage } = await import("./page");
const { POST } = await import("../../api/email/undo/route");

async function render(params: Record<string, string>) {
  return renderToStaticMarkup(await UndoPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  deleteEvent.mockReset().mockResolvedValue(undefined);
  claims.item = "all";
  batch = {
    id: "b1",
    userId: "u1",
    fromAddress: "h@example.com",
    subject: "Weekly",
    items: [
      {
        n: 1,
        action: { type: "create", candidate: { title: "PTA meeting", start: "2026-09-28T18:00:00-07:00", end: "2026-09-28T20:00:00-07:00" } },
        status: "applied",
        eventId: "ev1",
      },
      {
        n: 2,
        action: { type: "create", candidate: { title: "Coffee", start: "2026-09-30T08:00:00-07:00", end: "2026-09-30T08:30:00-07:00" } },
        status: "applied",
        eventId: "ev2",
      },
    ],
  };
});

describe("/email/undo page", () => {
  it("lists what the link covers and asks before changing anything", async () => {
    const html = await render({ t: "good" });
    expect(html).toContain("Undo everything kinroo did from");
    expect(html).toContain("Remove");
    expect(html).toContain("PTA meeting");
    expect(html).toContain('action="/api/email/undo"');
    expect(html).toContain("Undo 2 changes");
    expect(deleteEvent).not.toHaveBeenCalled();
  });

  it("covers only its own item for a per-item link", async () => {
    claims.item = 2;
    const html = await render({ t: "good" });
    expect(html).toContain("Coffee");
    expect(html).not.toContain("PTA meeting");
  });

  it("explains an invalid or expired link", async () => {
    expect(await render({ t: "bad" })).toContain("expired");
  });
});

describe("POST /api/email/undo", () => {
  async function submit(token: string) {
    const form = new FormData();
    form.set("t", token);
    return POST(new Request("https://kinroo.ai/api/email/undo", { method: "POST", body: form }));
  }

  it("undoes what the link covers and redirects back with done=1", async () => {
    const res = await submit("good");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://kinroo.ai/email/undo?t=good&done=1");
    expect(deleteEvent.mock.calls.map((c) => c[2])).toEqual(["ev1", "ev2"]);
    expect(batch.items.every((i) => i.status === "undone")).toBe(true);
  });

  it("changes nothing for a bad token", async () => {
    const res = await submit("bad");
    expect(res.headers.get("location")).toBe("https://kinroo.ai/email/undo?t=bad");
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});
