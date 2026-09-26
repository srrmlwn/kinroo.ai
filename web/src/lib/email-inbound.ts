// Pure parsing helpers for the inbound-email webhook (api/email/inbound) —
// kept separate from the route handler so the addressing/sentiment logic
// can be unit tested without a SendGrid payload or a DB.

const EMAIL_PATTERN = /<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g;

// A header value can be "Name <addr@x.com>", a bare address, or several of
// either joined by commas (a To/Cc line with multiple recipients).
export function extractAddresses(headerValue: string): string[] {
  const matches = [...headerValue.matchAll(EMAIL_PATTERN)];
  return matches.map((m) => (m[1] ?? m[2]).trim().toLowerCase());
}

export function parseSenderAddress(from: string): string | null {
  return extractAddresses(from)[0] ?? null;
}

export type RecipientAlias =
  | { kind: "add" }
  | { kind: "confirm"; pendingActionId: string }
  | { kind: "batch"; batchId: string };

// Finds whichever recipient address is one of ours (add@ or confirm+<id>@)
// among possibly several recipients on the To line, and classifies it.
export function parseRecipientAlias(toHeaderValue: string): RecipientAlias | null {
  for (const address of extractAddresses(toHeaderValue)) {
    const [localPart] = address.split("@");
    if (!localPart) continue;
    if (localPart.toLowerCase() === "add") return { kind: "add" };
    const confirmMatch = /^confirm\+(.+)$/i.exec(localPart);
    if (confirmMatch) return { kind: "confirm", pendingActionId: confirmMatch[1] };
    const batchMatch = /^batch\+(.+)$/i.exec(localPart);
    if (batchMatch) return { kind: "batch", batchId: batchMatch[1] };
  }
  return null;
}

// SendGrid forwards whatever "From" a message claims, even one that fails
// SPF/DKIM — the shared-secret query param on the webhook only proves the
// request came from SendGrid, not that the claimed sender is real. Without
// this check, anyone who learns the webhook URL could forge a registered
// user's address and act as them. SPF is a plain RFC 7208 result string
// ("pass"/"fail"/"softfail"/"neutral"/"none"/...); SendGrid's `dkim` field
// is a `{@domain : pass}`-shaped string per signing domain, so a substring
// check is more robust than assuming one exact format. Either signal
// passing is enough — matching typical "SPF or DKIM aligned" practice
// rather than requiring both.
export function isSenderAuthenticated(spf: string | null, dkim: string | null): boolean {
  const spfPass = spf?.trim().toLowerCase() === "pass";
  const dkimPass = dkim?.toLowerCase().includes("pass") ?? false;
  return spfPass || dkimPass;
}

const AFFIRMATIVE_PATTERN = /^\s*(y|yes|yep|yeah|confirm|ok|okay|sure|add it|do it)\b/i;
const NEGATIVE_PATTERN = /^\s*(n|no|nope|cancel|skip|don'?t|stop|nevermind)\b/i;

// Email reply bodies include quoted history below the actual reply, so only
// the first non-empty line is what the person actually typed.
export function classifyReply(body: string): "yes" | "no" | "unclear" {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  if (AFFIRMATIVE_PATTERN.test(firstLine)) return "yes";
  if (NEGATIVE_PATTERN.test(firstLine)) return "no";
  return "unclear";
}

// Stricter than isSenderAuthenticated, for the one path where a message
// changes the calendar with no confirmation step (email auto-apply): the
// message must carry a passing DKIM signature from the sender's own domain
// (or a parent/subdomain of it). SPF alone isn't enough — it vouches for the
// sending server, not the From address — and a DKIM pass from some other
// domain (a mailing-list relay, a forwarding service) says nothing about
// who wrote it. Anything that fails this falls back to reply-to-confirm.
export function isDkimAligned(dkim: string | null, senderAddress: string): boolean {
  if (!dkim) return false;
  const senderDomain = senderAddress.split("@")[1]?.toLowerCase();
  if (!senderDomain) return false;
  for (const match of dkim.matchAll(/@([a-z0-9.-]+)\s*:\s*([a-z]+)/gi)) {
    const signingDomain = match[1].toLowerCase();
    if (match[2].toLowerCase() !== "pass") continue;
    if (
      signingDomain === senderDomain ||
      senderDomain.endsWith(`.${signingDomain}`) ||
      signingDomain.endsWith(`.${senderDomain}`)
    ) {
      return true;
    }
  }
  return false;
}

// What the person actually typed in a reply, without the quoted message
// below it: stops at the first ">"-quoted line, an "On <date>, <x> wrote:"
// attribution, or a forwarded/original-message divider.
export function stripQuotedReply(body: string): string {
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">")) break;
    if (/^On .{4,200} wrote:$/i.test(trimmed)) break;
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}$/i.test(trimmed)) break;
    if (/^from:\s/i.test(trimmed) && kept.some((l) => l.trim())) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}
