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
  | { kind: "confirm"; pendingActionId: string };

// Finds whichever recipient address is one of ours (add@ or confirm+<id>@)
// among possibly several recipients on the To line, and classifies it.
export function parseRecipientAlias(toHeaderValue: string): RecipientAlias | null {
  for (const address of extractAddresses(toHeaderValue)) {
    const [localPart] = address.split("@");
    if (!localPart) continue;
    if (localPart.toLowerCase() === "add") return { kind: "add" };
    const confirmMatch = /^confirm\+(.+)$/i.exec(localPart);
    if (confirmMatch) return { kind: "confirm", pendingActionId: confirmMatch[1] };
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
