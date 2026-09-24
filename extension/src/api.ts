import { getConfig } from "./config";
import { getSessionToken } from "./auth";
import type { ParseResponse, CreateEventsResponse, CalendarEvent, EventAction } from "./types";

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// Not the standard `Authorization` header — Vercel's edge network
// intercepts/consumes that header for its own deployment-protection checks
// even on domains meant to be exempt from it, so a bearer token sent as
// `Authorization` never reaches the route handler. See web/src/lib/session.ts.
const SESSION_HEADER = "x-kinroo-session";

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const [config, token] = await Promise.all([getConfig(), getSessionToken()]);
  if (!token) throw new ApiError("Not signed in", 401);

  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: { ...init.headers, [SESSION_HEADER]: token },
  });
  if (res.status === 401) throw new ApiError("Session expired — please reconnect", 401);
  return res;
}

export async function getMe(): Promise<{ email: string; name?: string }> {
  const res = await apiFetch("/api/auth/me", { method: "GET" });
  if (!res.ok) throw new ApiError("Could not load account", res.status);
  return res.json();
}

export async function parseText(text: string): Promise<ParseResponse> {
  const res = await apiFetch("/api/parse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? "Could not parse that", res.status);
  }
  return res.json();
}

export async function parseFile(file: File): Promise<ParseResponse> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch("/api/parse", { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? "Could not parse that file", res.status);
  }
  return res.json();
}

// Used to flag scheduling conflicts in the confirm list before the user
// commits — a read, so it's fine to call speculatively and ignore failures.
export async function getEvents(start: string, end: string): Promise<{ events: CalendarEvent[] }> {
  const params = new URLSearchParams({ start, end });
  const res = await apiFetch(`/api/events?${params}`, { method: "GET" });
  if (!res.ok) throw new ApiError("Could not check for conflicts", res.status);
  return res.json();
}

// Used by the panel's default-calendar indicator — best-effort, read-only.
export async function getSettings(): Promise<{ defaultCalendarId: string }> {
  const res = await apiFetch("/api/settings", { method: "GET" });
  if (!res.ok) throw new ApiError("Could not load settings", res.status);
  return res.json();
}

// Used by the panel's "Settings" link: the web app has no login of its own,
// so this mints a short-lived token the extension hands off in a URL, which
// the backend exchanges for a browser session cookie (see
// api/auth/handoff/route.ts).
export async function requestHandoffToken(): Promise<{ token: string }> {
  const res = await apiFetch("/api/auth/handoff", { method: "POST" });
  if (!res.ok) throw new ApiError("Could not open settings", res.status);
  return res.json();
}

export async function applyActions(actions: EventAction[]): Promise<CreateEventsResponse> {
  const res = await apiFetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actions }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? "Could not save changes", res.status);
  }
  return res.json();
}

export { ApiError };
