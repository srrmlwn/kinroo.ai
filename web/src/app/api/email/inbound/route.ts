import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailIdentities, pendingEmailActions } from "@/lib/db/schema";
import { parseInput } from "@/lib/parse";
import { getUserSettings } from "@/lib/user-settings";
import { applyEventAction, type EventAction } from "@/lib/google-calendar";
import { sendEmail, confirmReplyAddress } from "@/lib/email";
import { parseSenderAddress, parseRecipientAlias, classifyReply } from "@/lib/email-inbound";

const PENDING_ACTION_TTL_MS = 24 * 60 * 60_000;

async function resolveUserId(address: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: emailIdentities.userId })
    .from(emailIdentities)
    .where(eq(emailIdentities.address, address))
    .limit(1);
  return row?.userId ?? null;
}

function formatWhen(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const dateLabel = startDate.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const startLabel = startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const endLabel = endDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${dateLabel}, ${startLabel}–${endLabel}`;
}

function describeAction(action: EventAction): string {
  if (action.type === "create") {
    return `Add "${action.candidate.title}" on ${formatWhen(action.candidate.start, action.candidate.end)}`;
  }
  if (action.type === "update") {
    return `Update "${action.original.title}" to ${formatWhen(action.candidate.start, action.candidate.end)}`;
  }
  return `Cancel "${action.original.title}" on ${formatWhen(action.original.start, action.original.end)}`;
}

// SendGrid Inbound Parse posts the received email as multipart/form-data —
// see SETUP.md for the DNS/domain-auth steps this depends on (not
// verifiable in this environment, same as the rest of the app per
// CLAUDE.md's "Current state"). Protected by a shared-secret query param
// rather than a signature, since Inbound Parse doesn't sign requests.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const expectedSecret = process.env.EMAIL_INGEST_WEBHOOK_SECRET;
  if (expectedSecret && url.searchParams.get("key") !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "Could not read form" }, { status: 400 });

  const to = String(form.get("to") ?? "");
  const from = String(form.get("from") ?? "");
  const subject = String(form.get("subject") ?? "");
  const text = String(form.get("text") ?? "");

  const alias = parseRecipientAlias(to);
  const senderAddress = parseSenderAddress(from);
  // Not addressed to one of our aliases, or no readable sender — 200 so
  // SendGrid doesn't retry a message we were never going to act on.
  if (!alias || !senderAddress) return Response.json({ ok: true });

  const userId = await resolveUserId(senderAddress);
  // Unregistered sender — no reply, so as not to confirm to a stranger that
  // this address is live.
  if (!userId) return Response.json({ ok: true });

  if (alias.kind === "confirm") {
    await handleConfirmationReply(userId, senderAddress, alias.pendingActionId, text);
  } else {
    await handleNewSubmission(userId, senderAddress, subject, text);
  }
  return Response.json({ ok: true });
}

async function handleNewSubmission(
  userId: string,
  senderAddress: string,
  subject: string,
  text: string,
) {
  const result = await parseInput(userId, { kind: "text", text: `${subject}\n\n${text}` }, "email");

  if (result.intent === "query") {
    await sendEmail({
      to: senderAddress,
      subject: `Re: ${subject || "your calendar question"}`,
      text: result.answer ?? "Nothing found for that.",
    }).catch((err) => console.error("[email/inbound] failed to send query answer", err));
    return;
  }

  const [action, ...rest] = result.actions;
  if (!action) {
    await sendEmail({
      to: senderAddress,
      subject: `Re: ${subject || "your email"}`,
      text: "Couldn't find an event in that email — try rephrasing and resend.",
    }).catch((err) => console.error("[email/inbound] failed to send not-found reply", err));
    return;
  }
  if (rest.length > 0) {
    // Reply-to-confirm only makes sense for one item at a time — matching a
    // terse "yes" back to one of several ambiguous matches isn't solved
    // here. v1 confirms the best/first match and drops the rest; the
    // extension's confirm list already handles the multi-match case for
    // create/update/delete initiated there.
    console.warn(
      `[email/inbound] ${rest.length + 1} candidates found in one email — only the first is queued for confirmation`,
    );
  }

  const [row] = await db
    .insert(pendingEmailActions)
    .values({
      userId,
      action,
      fromAddress: senderAddress,
      expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS),
    })
    .returning();

  await sendEmail({
    to: senderAddress,
    subject: `Confirm: ${describeAction(action)}`,
    text: `${describeAction(action)}?\n\nReply YES to confirm, or NO to skip. This request expires in 24 hours.`,
    replyTo: confirmReplyAddress(row.id),
  }).catch((err) => console.error("[email/inbound] failed to send confirmation request", err));
}

async function handleConfirmationReply(
  userId: string,
  senderAddress: string,
  pendingActionId: string,
  replyText: string,
) {
  const [pending] = await db
    .select()
    .from(pendingEmailActions)
    .where(eq(pendingEmailActions.id, pendingActionId))
    .limit(1);

  // Not found, already resolved, or belongs to a different user (comparing
  // resolved userId rather than raw address so this still holds if a user
  // ever registers a second address) — treat all three the same way.
  if (!pending || pending.userId !== userId || pending.status !== "pending") {
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar request",
      text: "That request has already expired or been handled.",
    }).catch((err) => console.error("[email/inbound] failed to send expired notice", err));
    return;
  }

  if (pending.expiresAt.getTime() < Date.now()) {
    await db
      .update(pendingEmailActions)
      .set({ status: "expired" })
      .where(eq(pendingEmailActions.id, pendingActionId));
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar request",
      text: "That request expired — send the original email again to retry.",
    }).catch((err) => console.error("[email/inbound] failed to send expired notice", err));
    return;
  }

  const decision = classifyReply(replyText);

  if (decision === "unclear") {
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar request",
      text: "Sorry, I didn't understand that — reply YES to confirm or NO to cancel.",
    }).catch((err) => console.error("[email/inbound] failed to send clarification request", err));
    return;
  }

  if (decision === "no") {
    await db
      .update(pendingEmailActions)
      .set({ status: "canceled" })
      .where(eq(pendingEmailActions.id, pendingActionId));
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar request",
      text: "Okay, not adding that.",
    }).catch((err) => console.error("[email/inbound] failed to send cancel confirmation", err));
    return;
  }

  const { defaultCalendarId } = await getUserSettings(userId);
  try {
    await applyEventAction(userId, defaultCalendarId, pending.action as EventAction);
    await db
      .update(pendingEmailActions)
      .set({ status: "confirmed" })
      .where(eq(pendingEmailActions.id, pendingActionId));
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar request",
      text: "Done — added to your calendar.",
    }).catch((err) => console.error("[email/inbound] failed to send success notice", err));
  } catch (err) {
    console.error("[email/inbound] failed to apply confirmed action", err);
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar request",
      text: "Something went wrong saving that to your calendar — please try again.",
    }).catch((sendErr) => console.error("[email/inbound] failed to send failure notice", sendErr));
  }
}
