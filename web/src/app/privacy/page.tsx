import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy — kinroo.ai",
  description: "How kinroo.ai accesses, stores, and protects your data.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-gray-600">{children}</div>
    </section>
  );
}

export default function PrivacyPolicy() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
        <p className="text-sm text-gray-500">Last updated September 25, 2026</p>
      </div>

      <p className="text-sm leading-relaxed text-gray-600">
        kinroo.ai (&ldquo;kinroo&rdquo;, &ldquo;we&rdquo;) turns plain-English text, screenshots, and
        photos into Google Calendar events, and answers questions about your schedule. This
        policy explains what we access, what we store, and why.
      </p>

      <Section title="What we access on your Google Account">
        <p>
          When you connect your Google Account, kinroo requests these OAuth scopes — nothing
          broader:
        </p>
        <ul className="list-disc pl-5">
          <li>
            <code className="text-xs">calendar.events</code> — see, create, edit, and delete events
            on your calendar. kinroo reads events to answer your questions and to warn you about
            conflicts. Every write is shown to you for confirmation before it happens; kinroo never
            creates or changes an event silently.
          </li>
          <li>
            <code className="text-xs">calendar.calendarlist.readonly</code> — list the names of
            your calendars, so the settings page can let you pick which one kinroo writes to,
            instead of asking you to paste a raw calendar ID.
          </li>
          <li>
            <code className="text-xs">openid</code>, <code className="text-xs">email</code> — your
            Google account email, used to identify your account with kinroo.
          </li>
        </ul>
        <p>
          kinroo does not request access to Gmail, Drive, Contacts, or any other Google product.
        </p>
      </Section>

      <Section title="What we store">
        <p>Google Calendar is the only place your event data lives. kinroo does not keep its own copy of your events. What we do store, in a Postgres database:</p>
        <ul className="list-disc pl-5">
          <li>Your Google account ID, email, and name, so we know who you are.</li>
          <li>
            Your Google OAuth tokens, encrypted at rest (AES-256-GCM) — never stored in plain
            text.
          </li>
          <li>
            Your preferences: timezone, default event duration, and which calendar kinroo writes
            to.
          </li>
          <li>
            Lightweight usage metadata for each request you send (how long it took, whether it
            used our AI parser, whether you confirmed or corrected the result). This is for
            reliability and cost monitoring — it does not include the text, image, or file content
            of your request.
          </li>
          <li>
            If you use email-based event requests: a temporary record of the action you asked for
            by email, held only until you reply to confirm or it expires.
          </li>
          <li>If you join our waitlist: the email address you submit.</li>
        </ul>
      </Section>

      <Section title="How your request is processed">
        <p>
          When you type a sentence, paste a screenshot, or upload a flyer or PDF, kinroo first
          tries to parse it with fast, local pattern-matching. When that isn&rsquo;t confident
          enough — ambiguous phrasing, a photo, a multi-page flyer — the text or image is sent to
          Anthropic&rsquo;s Claude API to extract the event details. That content is processed to
          generate a response and is not used by Anthropic to train models, per Anthropic&rsquo;s
          API terms.
        </p>
        <p>
          When you ask a question about your schedule, kinroo reads the relevant events from your
          Google Calendar. A simple question like &ldquo;what&rsquo;s on Sunday&rdquo; is answered
          directly from those events, without Claude. For other questions, such as &ldquo;when is
          my dentist appointment&rdquo; or &ldquo;am I free Saturday afternoon&rdquo;, kinroo
          sends your question to the Claude API along with the title, time, and location of each
          event in the period it covers. That period is the dates you asked about, or the next 60
          days if you didn&rsquo;t name any. Claude only picks which of those events answer the
          question. The answer you see is built from your actual calendar events, not written by
          the AI. The same Anthropic API terms apply to this content, and kinroo doesn&rsquo;t
          store it.
        </p>
        <p>
          Nothing is written to your calendar until you review and confirm it in the extension.
        </p>
      </Section>

      <Section title="Other services we rely on">
        <ul className="list-disc pl-5">
          <li>
            <strong>Google Calendar API</strong> — reads and writes events on your behalf, per the
            scopes above.
          </li>
          <li>
            <strong>Anthropic (Claude API)</strong> — parses text/image input into structured event
            data when our fast-path parser can&rsquo;t confidently handle it, and picks which of
            your calendar events answer a question, as described above.
          </li>
          <li>
            <strong>Neon</strong> — hosts our Postgres database (the account and settings data
            described above).
          </li>
          <li>
            <strong>Vercel</strong> — hosts kinroo&rsquo;s backend and this website.
          </li>
        </ul>
        <p>We do not sell your data, and we do not share it with anyone else for advertising or marketing purposes.</p>
      </Section>

      <Section title="Your controls">
        <ul className="list-disc pl-5">
          <li>
            Revoke kinroo&rsquo;s access at any time from your{" "}
            <a
              href="https://myaccount.google.com/permissions"
              className="text-blue-600 underline"
              target="_blank"
              rel="noreferrer"
            >
              Google Account permissions
            </a>{" "}
            page.
          </li>
          <li>
            Uninstalling the kinroo Chrome extension stops all activity, but doesn&rsquo;t by
            itself revoke Google access or delete your account data — do both of the above if you
            want a clean break.
          </li>
          <li>
            To request deletion of your account data from our database, email us at the address
            below.
          </li>
        </ul>
      </Section>

      <Section title="Children">
        <p>kinroo is not directed at children under 13, and we do not knowingly collect data from them.</p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          If this policy changes materially, we&rsquo;ll update the date at the top of this page.
          Continued use of kinroo after a change means you accept the update.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions, or want your data deleted? Email{" "}
          <a href="mailto:kinroo.ai@gmail.com" className="text-blue-600 underline">
            kinroo.ai@gmail.com
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
