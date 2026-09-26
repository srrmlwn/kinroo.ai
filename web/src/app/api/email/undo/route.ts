import { loadBatch, undoFromLink } from "@/lib/email-batch";
import { verifyUndoLinkToken } from "@/lib/session";
import { getUserSettings } from "@/lib/user-settings";

// The button on /email/undo posts here. The link in the summary email only
// ever opens that page — email security scanners and link previewers fetch
// every link in a message, so a link that undid something on GET would fire
// on its own.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const token = form ? String(form.get("t") ?? "") : "";
  const claims = token ? await verifyUndoLinkToken(token) : null;
  const back = new URL("/email/undo", request.url);
  back.searchParams.set("t", token);
  if (!claims) return Response.redirect(back, 303);

  const batch = await loadBatch(claims.batchId, claims.userId);
  if (!batch) return Response.redirect(back, 303);

  const { defaultCalendarId, timezone } = await getUserSettings(claims.userId);
  const { failed } = await undoFromLink(batch, claims.item, defaultCalendarId, timezone);
  back.searchParams.set(failed ? "failed" : "done", "1");
  return Response.redirect(back, 303);
}
