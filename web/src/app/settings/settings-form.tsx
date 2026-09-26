"use client";

import { useEffect, useState } from "react";

interface SettingsValues {
  timezone: string;
  defaultEventDurationMin: number;
  defaultCalendarId: string;
  emailAutoApply: boolean;
  extensionAutoApply: boolean;
}

interface CalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<CalendarOption[] | null>(null);
  const [needsReconnect, setNeedsReconnect] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/calendars", { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          if (body.error === "insufficient_scope") setNeedsReconnect(true);
          return;
        }
        if (!res.ok) return; // best-effort — fall back to the plain text field
        const body = await res.json();
        setCalendars(body.calendars);
      })
      .catch(() => {
        // Network failure or similar — same silent fallback as a non-OK
        // response above.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          timezone: values.timezone,
          defaultEventDurationMin: values.defaultEventDurationMin,
          defaultCalendarId: values.defaultCalendarId,
          emailAutoApply: values.emailAutoApply,
          extensionAutoApply: values.extensionAutoApply,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not save settings");
      }
      const updated = await res.json();
      setValues((v) => ({ ...v, ...updated }));
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not save settings");
    }
  }

  // The saved value might not be in the fetched list (a custom ID typed in
  // before this picker existed, or before reconnecting) — keep it
  // selectable rather than silently swapping it out from under the user.
  const calendarOptions =
    calendars && !calendars.some((c) => c.id === values.defaultCalendarId)
      ? [...calendars, { id: values.defaultCalendarId, summary: values.defaultCalendarId, primary: false }]
      : calendars;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Timezone</span>
        <input
          type="text"
          value={values.timezone}
          onChange={(e) => setValues((v) => ({ ...v, timezone: e.target.value }))}
          placeholder="America/Los_Angeles"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <span className="text-xs text-gray-500">An IANA timezone name — used to resolve dates like &quot;tomorrow&quot;.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Default event duration (minutes)</span>
        <input
          type="number"
          min={1}
          value={values.defaultEventDurationMin}
          onChange={(e) =>
            setValues((v) => ({ ...v, defaultEventDurationMin: Number(e.target.value) }))
          }
          className="rounded border border-gray-300 px-3 py-2"
        />
        <span className="text-xs text-gray-500">Used when an event has no stated end time.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Calendar</span>
        {calendarOptions ? (
          <select
            value={values.defaultCalendarId}
            onChange={(e) => setValues((v) => ({ ...v, defaultCalendarId: e.target.value }))}
            className="rounded border border-gray-300 px-3 py-2"
          >
            {calendarOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.summary}
                {c.primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={values.defaultCalendarId}
            onChange={(e) => setValues((v) => ({ ...v, defaultCalendarId: e.target.value }))}
            placeholder="primary"
            className="rounded border border-gray-300 px-3 py-2"
          />
        )}
        <span className="text-xs text-gray-500">
          {needsReconnect
            ? 'Reconnect the extension (sign out, then "Connect Google Calendar" again) to pick from your calendars directly — for now, enter an ID manually. "primary" is your main calendar.'
            : "Which Google Calendar to read/write."}
        </span>
      </label>

      <fieldset className="flex flex-col gap-3 text-sm">
        <legend className="mb-1 font-medium">Add events without asking first</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={values.emailAutoApply}
            onChange={(e) => setValues((v) => ({ ...v, emailAutoApply: e.target.checked }))}
          />
          <span>
            Email
            <span className="block text-xs text-gray-500">
              Changes from emails you send kinroo go straight on your calendar. kinroo replies with what it did,
              with one-click undo and edit links. Turn this off to reply YES/NO to each email instead.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={values.extensionAutoApply}
            onChange={(e) => setValues((v) => ({ ...v, extensionAutoApply: e.target.checked }))}
          />
          <span>
            Chrome extension
            <span className="block text-xs text-gray-500">
              Changes are made as soon as they&rsquo;re read, with an Undo button. Anything missing a date or
              title, or an edit or cancellation that matches more than one event, still waits for you to review it.
            </span>
          </span>
        </label>
      </fieldset>

      <button
        type="submit"
        disabled={status === "saving"}
        className="rounded bg-[#2075fe] px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {status === "saving" ? "Saving…" : "Save"}
      </button>

      {status === "saved" && <p className="text-sm text-green-600">Saved.</p>}
      {status === "error" && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
