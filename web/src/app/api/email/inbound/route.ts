import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailIdentities, pendingEmailActions } from "@/lib/db/schema";
import { parseInput } from "@/lib/parse";
import { getUserSettings } from "@/lib/user-settings";
import { applyEventAction, isCandidateComplete, type EventAction } from "@/lib/google-calendar";
import { sendEmail, confirmReplyAddress, batchReplyAddress } from "@/lib/email";
import {
  parseSenderAddress,
  parseRecipientAlias,
  classifyReply,
  isSenderAuthenticated,
  isDkimAligned,
  stripQuotedReply,
} from "@/lib/email-inbound";
import {
  applyEmailActions,
  editItem,
  itemStateLine,
  loadBatch,
  renderBatchSummary,
  saveBatchItems,
  summarySubject,
  undoItem,
  type EmailBatch,
  type SummaryLinks,
} from "@/lib/email-batch";
import { interpretSummaryReply } from "@/lib/claude";
import { logLlmCall } from "@/lib/llm-log";
import { createUndoLinkToken } from "@/lib/session";

const PENDING_ACTION_TTL_MS = 24 * 60 * 60_000;

async function resolveUserId(address: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: emailIdentities.userId })
    .from(emailIdentities)
    .where(eq(emailIdentities.address, address))
    .limit(1);
  return row?.userId ?? null;
}

// In the user's timezone — the server runs in UTC, so the default zone
// would show a 6 PM Pacific event as 1 AM.
function formatWhen(start: string, end: string, timezone: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const dateLabel = startDate.toLocaleDateString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const startLabel = startDate.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  const endLabel = endDate.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  return `${dateLabel}, ${startLabel}–${endLabel}`;
}

function describeAction(action: EventAction, timezone: string): string {
  if (action.type === "create") {
    return `Add "${action.candidate.title}" on ${formatWhen(action.candidate.start, action.candidate.end, timezone)}`;
  }
  if (action.type === "update") {
    return `Update "${action.original.title}" to ${formatWhen(action.candidate.start, action.candidate.end, timezone)}`;
  }
  return `Cancel "${action.original.title}" on ${formatWhen(action.original.start, action.original.end, timezone)}`;
}

// SendGrid Inbound Parse posts the received email as multipart/form-data —
// see SETUP.md for the DNS/domain-auth steps this depends on (not
// verifiable in this environment, same as the rest of the app per
// CLAUDE.md's "Current state"). Protected by a shared-secret query param
// rather than a signature, since Inbound Parse doesn't sign requests.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const expectedSecret = process.env.EMAIL_INGEST_WEBHOOK_SECRET;
  if (expectedSecret && url.searchParams.get("secret") !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ error: "Could not read form" }, { status: 400 });

  const to = String(form.get("to") ?? "");
  const from = String(form.get("from") ?? "");
  const subject = String(form.get("subject") ?? "");
  const text = String(form.get("text") ?? "");
  const spf = form.get("SPF") ? String(form.get("SPF")) : null;
  const dkim = form.get("dkim") ? String(form.get("dkim")) : null;

  const alias = parseRecipientAlias(to);
  const senderAddress = parseSenderAddress(from);
  // Not addressed to one of our aliases, or no readable sender — 200 so
  // SendGrid doesn't retry a message we were never going to act on.
  if (!alias || !senderAddress) return Response.json({ ok: true });

  // The webhook secret only proves this request came from SendGrid — it
  // says nothing about whether the "From" header is real. Reject a claimed
  // sender that fails both SPF and DKIM the same way as an unregistered
  // sender: silently, so a forged address doesn't get a reply confirming
  // it reached a live account.
  if (!isSenderAuthenticated(spf, dkim)) {
    console.warn(`[email/inbound] rejected unauthenticated sender ${senderAddress} (SPF=${spf}, dkim=${dkim})`);
    return Response.json({ ok: true });
  }

  const userId = await resolveUserId(senderAddress);
  // Unregistered sender — no reply, so as not to confirm to a stranger that
  // this address is live.
  if (!userId) return Response.json({ ok: true });

  // Undo links point back at this same deployment — whatever public origin
  // SendGrid delivered the webhook to — so no separate base-URL setting.
  const origin = url.origin;
  if (alias.kind === "confirm") {
    await handleConfirmationReply(userId, senderAddress, alias.pendingActionId, text);
  } else if (alias.kind === "batch") {
    await handleSummaryReply(userId, senderAddress, alias.batchId, text, origin);
  } else {
    const autoApply = (await getUserSettings(userId)).emailAutoApply && isDkimAligned(dkim, senderAddress);
    await handleNewSubmission(userId, senderAddress, subject, text, autoApply ? origin : null);
  }
  return Response.json({ ok: true });
}

// Precomputes the signed undo URL for every item (and "all") the summary
// may link to — token signing is async, rendering isn't.
async function summaryLinks(batch: EmailBatch, origin: string): Promise<SummaryLinks> {
  const urls = new Map<number | "all", string>();
  for (const key of [...batch.items.map((i) => i.n), "all" as const]) {
    const token = await createUndoLinkToken({ userId: batch.userId, batchId: batch.id, item: key });
    urls.set(key, `${origin}/email/undo?t=${encodeURIComponent(token)}`);
  }
  return { undo: (item) => urls.get(item) ?? `${origin}/email/undo` };
}

async function sendSummary(batch: EmailBatch, timezone: string, origin: string, intro?: string) {
  const body = renderBatchSummary(batch, timezone, await summaryLinks(batch, origin));
  await sendEmail({
    to: batch.fromAddress,
    subject: summarySubject(batch),
    text: intro ? `${intro}\n\n${body}` : body,
    replyTo: batchReplyAddress(batch.id),
  }).catch((err) => console.error("[email/inbound] failed to send summary", err));
}

// `autoApplyOrigin` is the base URL for undo links when this email should
// be applied without a confirmation round trip (setting on, and the sender
// passes the stricter DKIM check), or null to use reply-to-confirm.
async function handleNewSubmission(
  userId: string,
  senderAddress: string,
  subject: string,
  text: string,
  autoApplyOrigin: string | null,
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

  if (autoApplyOrigin) {
    const { defaultCalendarId, timezone } = await getUserSettings(userId);
    // An edit or cancel request finds existing events by keyword search,
    // which can match several — applying to all of them would change or
    // cancel events the user never meant. Ask which one instead.
    const edits = result.actions.filter(
      (a): a is Exclude<EventAction, { type: "create" }> => a.type !== "create",
    );
    if (edits.length > 1) {
      const list = edits
        .map((a, i) => `${i + 1}. ${a.original.title} — ${formatWhen(a.original.start, a.original.end, timezone)}`)
        .join("\n");
      await sendEmail({
        to: senderAddress,
        subject: `Re: ${subject || "your email"}`,
        text: `That matches ${edits.length} events, so nothing was changed:\n\n${list}\n\nSend it again naming the one you mean — for example with its date.`,
      }).catch((err) => console.error("[email/inbound] failed to send ambiguous-match reply", err));
      return;
    }
    const batch = await applyEmailActions({
      userId,
      calendarId: defaultCalendarId,
      fromAddress: senderAddress,
      subject,
      actions: result.actions,
    });
    await sendSummary(batch, timezone, autoApplyOrigin);
    return;
  }
  // Email can only confirm with a YES/NO, so there's no way to fill in a
  // missing date or title the way the extension's confirm screen does.
  if (action.type !== "delete" && !isCandidateComplete(action.candidate)) {
    await sendEmail({
      to: senderAddress,
      subject: `Re: ${subject || "your email"}`,
      text: "Couldn't find both an event name and a date/time in that email — add whichever is missing and resend.",
    }).catch((err) => console.error("[email/inbound] failed to send incomplete-event reply", err));
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

  const { timezone } = await getUserSettings(userId);
  await sendEmail({
    to: senderAddress,
    subject: `Confirm: ${describeAction(action, timezone)}`,
    text: `${describeAction(action, timezone)}?\n\nReply YES to confirm, or NO to skip. This request expires in 24 hours.`,
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

// A reply to an auto-apply summary ("1 is at 7pm, remove 2"): Claude maps
// it onto the numbered items, each operation is checked against the batch
// and carried out, and an updated summary goes back.
async function handleSummaryReply(
  userId: string,
  senderAddress: string,
  batchId: string,
  body: string,
  origin: string,
) {
  const batch = await loadBatch(batchId, userId);
  if (!batch) {
    await sendEmail({
      to: senderAddress,
      subject: "Re: your calendar changes",
      text: "Couldn't find the summary you replied to. Forward the original email to kinroo again to start over.",
    }).catch((err) => console.error("[email/inbound] failed to send batch-not-found reply", err));
    return;
  }
  const reply = stripQuotedReply(body);
  if (!reply) return;

  const { defaultCalendarId, timezone } = await getUserSettings(userId);
  const startedAt = Date.now();
  let interpreted: Awaited<ReturnType<typeof interpretSummaryReply>>;
  try {
    interpreted = await interpretSummaryReply(
      reply,
      batch.items.map((item) => ({ n: item.n, line: itemStateLine(item, timezone) })),
      { timezone, referenceDate: new Date() },
    );
  } catch (err) {
    console.error("[email/inbound] failed to interpret summary reply", err);
    await sendSummary(batch, timezone, origin, "Sorry, something went wrong reading your reply. Please try again.");
    return;
  }
  logLlmCall({
    userId,
    channel: "email-reply",
    inputType: "text",
    usedLlm: true,
    model: interpreted.model,
    intent: "update",
    candidateCount: interpreted.operations.length,
    promptTokens: interpreted.promptTokens,
    completionTokens: interpreted.completionTokens,
    latencyMs: Date.now() - startedAt,
  });

  if (interpreted.operations.length === 0) {
    const intro = interpreted.unclear
      ? 'Sorry, I couldn\'t tell what to change. Reply with the item number and what to do — for example "1 is at 7pm" or "remove 2".'
      : "Got it — nothing changed.";
    await sendSummary(batch, timezone, origin, intro);
    return;
  }

  const outcomes: string[] = [];
  for (const op of interpreted.operations) {
    const index = batch.items.findIndex((item) => item.n === op.item);
    if (index === -1) {
      outcomes.push(`There's no item ${op.item}.`);
      continue;
    }
    const item = batch.items[index];
    try {
      if (op.op === "undo") {
        if (item.status !== "applied") {
          outcomes.push(`${op.item}: nothing to undo.`);
          continue;
        }
        batch.items[index] = await undoItem(userId, defaultCalendarId, timezone, item);
        outcomes.push(`${op.item}: done.`);
      } else {
        const { item: next, error } = await editItem(userId, defaultCalendarId, item, op, batch.subject);
        batch.items[index] = next;
        outcomes.push(error ? `${op.item} ${error}.` : `${op.item}: updated.`);
      }
    } catch (err) {
      console.error("[email/inbound] failed to apply reply operation", op, err);
      outcomes.push(`${op.item}: couldn't be saved to your calendar — try again.`);
    }
  }
  await saveBatchItems(batch);
  await sendSummary(batch, timezone, origin, outcomes.join("\n"));
}
