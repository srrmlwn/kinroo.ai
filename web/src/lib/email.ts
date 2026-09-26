function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Deliberately a different domain than EMAIL_INGEST_DOMAIN — SendGrid's
// Sender Authentication (SPF/DKIM) is set up for the root domain (SETUP.md
// §10 step 2), while EMAIL_INGEST_DOMAIN is a subdomain only used for
// receiving via Inbound Parse. Sending "From" an address on a domain
// SendGrid hasn't authenticated gets rejected with a 403 Sender Identity
// error, even though the two domains share a registrant.
export function fromAddress(): string {
  return `kinroo@${requireEnv("EMAIL_FROM_DOMAIN")}`;
}

export function confirmReplyAddress(pendingActionId: string): string {
  return `confirm+${pendingActionId}@${requireEnv("EMAIL_INGEST_DOMAIN")}`;
}

// Reply-to on an auto-apply summary email: a reply lands back on the
// inbound webhook addressed to this batch, so "remove 2" knows which
// email's item 2 it means.
export function batchReplyAddress(batchId: string): string {
  return `batch+${batchId}@${requireEnv("EMAIL_INGEST_DOMAIN")}`;
}

// Transactional send via SendGrid's Mail Send API — this project's only
// outbound email need is the reply-to-confirm loop, so no template/queue
// system, just a direct API call. Domain auth (SPF/DKIM) for the sending
// domain is set up in SendGrid, not here — see SETUP.md.
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<void> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("SENDGRID_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: opts.to }] }],
      from: { email: fromAddress(), name: "kinroo.ai" },
      reply_to: opts.replyTo ? { email: opts.replyTo } : undefined,
      subject: opts.subject,
      content: [{ type: "text/plain", value: opts.text }],
    }),
  });
  if (!res.ok) {
    throw new Error(`SendGrid send failed: ${res.status} ${await res.text()}`);
  }
}
