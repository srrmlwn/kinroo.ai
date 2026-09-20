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

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const [config, token] = await Promise.all([getConfig(), getSessionToken()]);
  if (!token) throw new ApiError("Not signed in", 401);

  const res = await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
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
