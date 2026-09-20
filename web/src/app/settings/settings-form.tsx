"use client";

import { useState } from "react";

interface SettingsValues {
  timezone: string;
  defaultEventDurationMin: number;
  defaultCalendarId: string;
  confirmBeforeWrite: boolean;
}

export function SettingsForm({ initial }: { initial: SettingsValues }) {
  const [values, setValues] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

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
        <span className="font-medium">Calendar ID</span>
        <input
          type="text"
          value={values.defaultCalendarId}
          onChange={(e) => setValues((v) => ({ ...v, defaultCalendarId: e.target.value }))}
          placeholder="primary"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <span className="text-xs text-gray-500">
          Which Google Calendar to read/write. &quot;primary&quot; is your main calendar.
        </span>
      </label>

      <label className="flex items-center gap-2 text-sm text-gray-500">
        <input type="checkbox" checked={values.confirmBeforeWrite} disabled />
        <span>Confirm before every write (always on)</span>
      </label>

      <button
        type="submit"
        disabled={status === "saving"}
        className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {status === "saving" ? "Saving…" : "Save"}
      </button>

      {status === "saved" && <p className="text-sm text-green-600">Saved.</p>}
      {status === "error" && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
