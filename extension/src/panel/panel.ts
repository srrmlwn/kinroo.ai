import { clearSession, getSessionToken } from "../auth";
import {
  getMe,
  parseText,
  parseFile,
  applyActions,
  requestHandoffToken,
  getEvents,
  getSettings,
  ApiError,
} from "../api";
import { getConfig } from "../config";
import { annotateConflicts } from "../conflicts";
import type { EventAction, EditableAction, ParseResponse, CalendarEvent, CreateEventsResponse } from "../types";

type View =
  | { kind: "loading" }
  | { kind: "unauthenticated"; error?: string }
  | {
      kind: "ready";
      email: string;
      pictureUrl?: string;
      pendingFile?: File;
      busy?: boolean;
      notice?: string;
      undo?: EventAction[];
      calendarLabel?: string;
      upcomingEvents?: CalendarEvent[];
      upcomingLoading?: boolean;
    }
  | { kind: "confirming"; email: string; actions: EditableAction[]; busy?: boolean; error?: string }
  | { kind: "answer"; email: string; text: string };

let state: View = { kind: "loading" };
let inputText = "";
let avatarMenuOpen = false;

// Minimal inline icons (Feather-style: 24x24, stroke=currentColor) — no
// icon library dependency for a handful of glyphs.
const ICON_ATTACH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05L12.25 20.24a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
const ICON_SEND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
const ICON_SCAN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V4a1 1 0 011-1h3"/><path d="M17 3h3a1 1 0 011 1v3"/><path d="M21 17v3a1 1 0 01-1 1h-3"/><path d="M7 21H4a1 1 0 01-1-1v-3"/></svg>';
const ICON_SETTINGS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2" fill="currentColor" stroke="none"/></svg>';

// Cached across ready-state re-entries within one panel session — the
// default calendar rarely changes and re-fetching it on every confirm would
// just be wasted latency; upcoming events are still refetched each time
// (see enterReady) since a write can change them.
let cachedCalendarLabel: string | undefined;
let cachedUpcoming: CalendarEvent[] | undefined;
let cachedPictureUrl: string | undefined;

// The image thumbnail in the file-chip needs an object URL, which must be
// revoked when replaced or removed or it leaks for the life of the panel.
let pendingFileThumbUrl: string | null = null;
function revokeThumb() {
  if (pendingFileThumbUrl) {
    URL.revokeObjectURL(pendingFileThumbUrl);
    pendingFileThumbUrl = null;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("panel root element missing");

function setState(next: View) {
  state = next;
  persistDraft(next);
  render();
}

// The side panel persists across tab switches and ordinary focus loss
// (unlike the old action popup, which Chrome destroyed on any click
// elsewhere) — but it can still be closed by the user, reloaded during
// development, or lost on a browser restart. So anything worth not losing
// mid-compose is mirrored to storage here and restored in init() when the
// panel is (re)opened. pendingFile (a File) can't be serialized, so an
// attached-but-unparsed file is the one thing this doesn't cover —
// everything after parsing (actions, answers) does. Ephemeral, re-fetchable
// state (notice, undo, calendarLabel, upcomingEvents) is deliberately left
// out — restoring a stale "Undone." notice or a stale undo action would be
// actively misleading.
function persistDraft(view: View) {
  let payload: unknown = null;
  if (view.kind === "confirming") {
    payload = { kind: "confirming", actions: view.actions };
  } else if (view.kind === "answer") {
    payload = { kind: "answer", text: view.text };
  } else if (view.kind === "ready") {
    payload = { kind: "ready", inputText };
  }
  if (payload) {
    chrome.storage.local.set({ draft: payload }).catch(() => {});
  } else {
    chrome.storage.local.remove("draft").catch(() => {});
  }
}

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

// "Today" / "Tomorrow" / "Mon 21" — used by the upcoming-events tiles, where
// a full "Mon, Sep 21" date repeated five times in a row is just noise.
function formatRelativeDay(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.getDate()}`;
}

function formatTimeBadge(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatEventTime(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const dateLabel = startDate.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const startLabel = startDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const endLabel = endDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateLabel}, ${startLabel}–${endLabel}`;
}

// Safe for text-node context (between tags) — the browser's serializer
// escapes &, <, > there but NOT quote characters, so this must never be
// used inside a quoted HTML attribute (use escapeAttr for that).
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Safe for interpolating into a quoted HTML attribute value.
function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Best-effort: pre-fill the compose box with whatever's selected on the
// page you were looking at, so the common case (select a line, open the
// panel, hit Go) doesn't require the right-click menu. activeTab makes this
// a one-off, no standing host access. Fails silently on chrome://, the
// Chrome Web Store, PDFs, etc. — those just get a blank compose box.
async function readPageSelection(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString().trim() ?? "",
    });
    return typeof injection?.result === "string" ? injection.result : "";
  } catch {
    return "";
  }
}

// Since the panel now stays open across tab switches instead of reopening
// fresh each time (see the persistDraft comment above), a plain "read the
// selection once in init()" would miss a selection made after the panel was
// already open. This re-checks on tab activity, but only refills an
// otherwise-untouched compose box — never overwrites something the user is
// mid-typing or a file they've attached.
async function maybeRefreshSelection(): Promise<void> {
  if (state.kind !== "ready" || inputText.trim() || state.pendingFile) return;
  const selection = await readPageSelection();
  if (selection && state.kind === "ready" && !inputText.trim() && !state.pendingFile) {
    inputText = selection;
    setState({ ...state });
  }
}
chrome.tabs.onActivated.addListener(() => {
  maybeRefreshSelection();
});
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "complete") maybeRefreshSelection();
});

// The avatar dropdown closes on any click outside it. Registered once at
// module scope rather than per-render since it needs to catch clicks
// anywhere in the document, not just inside the header.
document.addEventListener("click", (e) => {
  if (!avatarMenuOpen) return;
  if ((e.target as Element | null)?.closest("#avatar-wrapper")) return;
  avatarMenuOpen = false;
  render();
});

// Explicit, on-demand full-page scan — a separate action ("Detect events on
// this page") rather than something that silently prefills the compose box,
// since dumping a whole page's text into a visible text field the user
// didn't ask to fill is noisy and easy to mistake for something they typed.
const MAX_PAGE_SCAN_CHARS = 4000;

async function scanPageText(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body?.innerText ?? "",
    });
    return typeof injection?.result === "string"
      ? injection.result.trim().slice(0, MAX_PAGE_SCAN_CHARS)
      : "";
  } catch {
    return "";
  }
}

const UPCOMING_WINDOW_DAYS = 14;
const UPCOMING_LIMIT = 5;

async function fetchUpcoming(): Promise<CalendarEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { events } = await getEvents(now.toISOString(), end.toISOString());
  return events.slice(0, UPCOMING_LIMIT);
}

async function fetchCalendarLabel(): Promise<string> {
  try {
    const { defaultCalendarId } = await getSettings();
    return defaultCalendarId === "primary" ? "Primary calendar" : defaultCalendarId;
  } catch {
    return "";
  }
}

async function loadUpcoming(email: string): Promise<void> {
  try {
    const events = await fetchUpcoming();
    cachedUpcoming = events;
    if (state.kind === "ready" && state.email === email) {
      setState({ ...state, upcomingEvents: events, upcomingLoading: false });
    }
  } catch (err) {
    console.error("[kinroo] failed to load upcoming events", err);
    if (state.kind === "ready" && state.email === email) {
      setState({ ...state, upcomingEvents: [], upcomingLoading: false });
    }
  }
}

async function loadCalendarLabel(email: string): Promise<void> {
  const label = await fetchCalendarLabel();
  cachedCalendarLabel = label;
  if (state.kind === "ready" && state.email === email && label) {
    setState({ ...state, calendarLabel: label });
  }
}

// Single entry point for landing on the ready view — used on connect,
// after a confirm/undo round-trip, and when backing out of confirm/answer —
// so upcoming events and the calendar label are always kept current rather
// than duplicated at every call site.
function enterReady(email: string, opts?: { notice?: string; undo?: EventAction[] }): void {
  avatarMenuOpen = false;
  setState({
    kind: "ready",
    email,
    pictureUrl: cachedPictureUrl,
    notice: opts?.notice,
    undo: opts?.undo,
    calendarLabel: cachedCalendarLabel,
    upcomingEvents: cachedUpcoming,
    upcomingLoading: cachedUpcoming === undefined,
  });
  if (cachedCalendarLabel === undefined) loadCalendarLabel(email);
  loadUpcoming(email);
}

async function init() {
  const token = await getSessionToken();
  if (!token) {
    setState({ kind: "unauthenticated" });
    return;
  }
  try {
    const me = await getMe();
    cachedPictureUrl = me.pictureUrl;
    const { draft } = await chrome.storage.local.get("draft");
    if (draft?.kind === "confirming" && Array.isArray(draft.actions) && draft.actions.length > 0) {
      setState({ kind: "confirming", email: me.email, actions: draft.actions });
      return;
    }
    if (draft?.kind === "answer" && typeof draft.text === "string") {
      setState({ kind: "answer", email: me.email, text: draft.text });
      return;
    }
    inputText = draft?.kind === "ready" && typeof draft.inputText === "string" ? draft.inputText : "";
    if (!inputText) {
      inputText = await readPageSelection();
    }
    enterReady(me.email);
  } catch {
    await clearSession();
    setState({ kind: "unauthenticated" });
  }
}

async function handleConnect() {
  setState({ kind: "loading" });
  try {
    // Runs in the background worker, not here — chrome.identity's consent
    // window steals focus, and running it there keeps sign-in independent
    // of whether this panel document is even open (see background.ts).
    const result = await chrome.runtime.sendMessage({ type: "connect-google" });
    if (!result?.ok) throw new Error(result?.error ?? "Sign-in failed");
    cachedPictureUrl = result.pictureUrl;
    enterReady(result.email);
  } catch (err) {
    setState({
      kind: "unauthenticated",
      error: err instanceof Error ? err.message : "Sign-in failed",
    });
  }
}

async function handleSignOut() {
  await clearSession();
  cachedCalendarLabel = undefined;
  cachedUpcoming = undefined;
  setState({ kind: "unauthenticated" });
}

async function handleOpenSettings(current: Extract<View, { kind: "ready" }>) {
  try {
    const [{ token }, config] = await Promise.all([requestHandoffToken(), getConfig()]);
    await chrome.tabs.create({ url: `${config.apiBase}/api/auth/handoff?token=${encodeURIComponent(token)}` });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await clearSession();
      setState({ kind: "unauthenticated", error: "Session expired — please reconnect" });
      return;
    }
    setState({
      ...current,
      notice: err instanceof Error ? err.message : "Could not open settings",
    });
  }
}

// Shared by the compose box (handleSubmit) and the page-scan button
// (handleDetectPage) — both end up with a ParseResponse to react to, they
// just differ in where the text they sent came from.
async function handleParsed(current: Extract<View, { kind: "ready" }>, result: ParseResponse) {
  if (result.intent === "query") {
    inputText = "";
    setState({ kind: "answer", email: current.email, text: result.answer ?? "Nothing found." });
    return;
  }

  if (result.actions.length > 0) {
    inputText = "";
    // A single match is safe to default-select (matches the existing
    // bulk-flyer "accept all" UX); multiple ambiguous update/delete
    // matches default unchecked so the user picks the right one.
    const editable: EditableAction[] = result.actions.map((action) => ({
      action,
      selected: action.type === "create" || result.actions.length === 1,
    }));
    const annotated = await annotateConflicts(editable);
    setState({ kind: "confirming", email: current.email, actions: annotated });
    return;
  }

  const notice =
    result.intent === "update"
      ? "Couldn't find a matching event to update — try being more specific."
      : result.intent === "delete"
        ? "Couldn't find a matching event to cancel — try being more specific."
        : "Couldn't find an event or question in that — try rephrasing.";
  setState({ ...current, pendingFile: undefined, busy: false, notice });
}

function handleApiErrorOrElse(
  current: Extract<View, { kind: "ready" }>,
  err: unknown,
): void {
  if (err instanceof ApiError && err.status === 401) {
    clearSession().then(() =>
      setState({ kind: "unauthenticated", error: "Session expired — please reconnect" }),
    );
    return;
  }
  setState({
    ...current,
    busy: false,
    notice: err instanceof Error ? err.message : "Something went wrong",
  });
}

async function handleSubmit(current: Extract<View, { kind: "ready" }>) {
  if (!inputText.trim() && !current.pendingFile) return;
  setState({ ...current, busy: true });
  try {
    const result = current.pendingFile
      ? await parseFile(current.pendingFile)
      : await parseText(inputText.trim());
    await handleParsed(current, result);
  } catch (err) {
    handleApiErrorOrElse(current, err);
  }
}

async function handleDetectPage(current: Extract<View, { kind: "ready" }>) {
  setState({ ...current, busy: true, notice: undefined });
  try {
    const pageText = await scanPageText();
    if (!pageText) {
      setState({ ...current, busy: false, notice: "Couldn't read any text on this page." });
      return;
    }
    const result = await parseText(pageText);
    await handleParsed(current, result);
  } catch (err) {
    handleApiErrorOrElse(current, err);
  }
}

// Fires after a start/end edit; the row already re-rendered without a
// conflict badge, this fills it back in once the check comes back. Guards
// on view kind since the panel may have moved on (confirm/cancel) by then.
function recheckConflicts(actions: EditableAction[]): void {
  annotateConflicts(actions).then((annotated) => {
    if (state.kind === "confirming") setState({ ...state, actions: annotated });
  });
}

// "delete" actions have no candidate to patch — a no-op there is fine since
// no editable fields render for them.
function withCandidatePatch(action: EventAction, patch: { title?: string; start?: string; end?: string }): EventAction {
  if (action.type === "delete") return action;
  return { ...action, candidate: { ...action.candidate, ...patch } };
}

// Builds the inverse of each just-applied action so a single "Undo" click
// can reuse the exact same applyActions()/api/events round-trip rather than
// a dedicated undo endpoint. A create's undo is a delete of the event Google
// just handed back; an update's undo restores the pre-edit fields we
// already had client-side (action.original); a delete's undo recreates the
// event from those same fields — necessarily lossy (Google's own id,
// recurrence, etc. are gone), but a close approximation is better than none,
// and Google's own Calendar trash still covers a truly precise recovery.
function buildUndoActions(selected: EditableAction[], results: CreateEventsResponse["events"]): EventAction[] {
  const undo: EventAction[] = [];
  selected.forEach((item, i) => {
    const result = results[i];
    if (!result?.ok) return;
    const { action } = item;
    if (action.type === "create") {
      if (!result.event) return;
      undo.push({ type: "delete", eventId: result.event.id, original: result.event });
    } else if (action.type === "update") {
      undo.push({
        type: "update",
        eventId: action.eventId,
        original: result.event ?? action.original,
        candidate: {
          title: action.original.title,
          start: action.original.start,
          end: action.original.end,
          location: action.original.location,
          timezone: action.candidate.timezone,
        },
      });
    } else {
      undo.push({
        type: "create",
        candidate: {
          title: action.original.title,
          start: action.original.start,
          end: action.original.end,
          location: action.original.location,
        },
      });
    }
  });
  return undo;
}

async function handleConfirm(current: Extract<View, { kind: "confirming" }>) {
  const selected = current.actions.filter((a) => a.selected);
  if (selected.length === 0) return;
  setState({ ...current, busy: true, error: undefined });
  try {
    const result = await applyActions(selected.map((a) => a.action));
    const failures = result.events.filter((e) => !e.ok);
    if (failures.length > 0) {
      setState({
        ...current,
        busy: false,
        error: `${failures.length} of ${selected.length} change(s) failed to save. Try again?`,
      });
      return;
    }
    const verb =
      selected[0].action.type === "delete"
        ? "Canceled"
        : selected[0].action.type === "update"
          ? "Updated"
          : "Added";
    const undo = buildUndoActions(selected, result.events);
    enterReady(current.email, {
      notice: `${verb} ${selected.length} event(s).`,
      undo: undo.length > 0 ? undo : undefined,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await clearSession();
      setState({ kind: "unauthenticated", error: "Session expired — please reconnect" });
      return;
    }
    setState({
      ...current,
      busy: false,
      error: err instanceof Error ? err.message : "Something went wrong",
    });
  }
}

async function handleUndo(current: Extract<View, { kind: "ready" }>) {
  if (!current.undo?.length) return;
  setState({ ...current, busy: true });
  try {
    await applyActions(current.undo);
    enterReady(current.email, { notice: "Undone." });
  } catch (err) {
    handleApiErrorOrElse(current, err);
  }
}

function renderUnauthenticated(view: Extract<View, { kind: "unauthenticated" }>): string {
  return `
    <p class="lead">Turn plain English into Google Calendar events.</p>
    ${view.error ? `<p class="notice error">${escapeHtml(view.error)}</p>` : ""}
    <button id="connect" class="primary">Connect Google Calendar</button>
  `;
}

const EXAMPLE_PROMPTS = [
  "What's on Saturday?",
  "Doctor's appointment at 9am tomorrow",
  "Cancel my dentist appointment",
];

function renderUpcoming(view: Extract<View, { kind: "ready" }>): string {
  const body = view.upcomingLoading
    ? `<p class="upcoming-empty">Loading…</p>`
    : !view.upcomingEvents?.length
      ? `<p class="upcoming-empty">Nothing on your calendar for the next two weeks.</p>`
      : view.upcomingEvents
          .map(
            (event) => `
        <div class="upcoming-tile" title="${escapeAttr(formatEventTime(event.start, event.end))}">
          <span class="upcoming-day">${escapeHtml(formatRelativeDay(event.start))}</span>
          <span class="upcoming-item-title">${escapeHtml(event.title)}</span>
          <span class="upcoming-time-badge">${escapeHtml(formatTimeBadge(event.start))}</span>
        </div>`,
          )
          .join("");
  return `
    <div class="upcoming">
      <p class="upcoming-heading">Upcoming</p>
      ${body}
      <a id="open-calendar" class="calendar-link" href="https://calendar.google.com/calendar/r" target="_blank" rel="noopener">Open Google Calendar ↗</a>
    </div>
  `;
}

// Rendered into the static #header-actions slot in panel.html (empty for
// every other view) — an icon cluster instead of raw email/calendar text,
// which used to cost ~30px of vertical space on every single screen.
function renderHeaderActions(view: Extract<View, { kind: "ready" }>): string {
  const initial = view.email.trim().charAt(0).toUpperCase() || "?";
  return `
    <button id="settings-icon" class="icon-btn" title="Settings" aria-label="Settings">${ICON_SETTINGS}</button>
    <div id="avatar-wrapper" class="avatar-wrapper">
      <button id="avatar-btn" class="avatar-btn" title="${escapeAttr(view.email)}" aria-label="Account">
        ${
          view.pictureUrl
            ? `<img id="avatar-img" class="avatar-img" src="${escapeAttr(view.pictureUrl)}" alt="" referrerpolicy="no-referrer" />`
            : ""
        }
        <span class="avatar-initial">${escapeHtml(initial)}</span>
      </button>
      ${
        avatarMenuOpen
          ? `<div class="avatar-menu">
               <div class="avatar-menu-email">${escapeHtml(view.email)}</div>
               ${view.calendarLabel ? `<div class="avatar-menu-calendar">→ ${escapeHtml(view.calendarLabel)}</div>` : ""}
               <button id="signout" class="avatar-menu-item">Sign out</button>
             </div>`
          : ""
      }
    </div>
  `;
}

function renderReady(view: Extract<View, { kind: "ready" }>): string {
  const fileChip = view.pendingFile
    ? `<div class="file-chip">
         ${view.pendingFile.type.startsWith("image/") ? `<img id="file-thumb" class="file-thumb" alt="" />` : ""}
         <span class="file-name">${escapeHtml(view.pendingFile.name)}</span>
         <button id="remove-file" class="link">remove</button>
       </div>`
    : "";

  // Suggestions are only useful before you've started typing — once there's
  // real input they'd just be dead weight competing with it.
  const chips = inputText.trim()
    ? ""
    : `<div class="chips-wrap">
         <div class="chips">
           ${EXAMPLE_PROMPTS.map((p) => `<button type="button" class="chip" ${view.busy ? "disabled" : ""}>${escapeHtml(p)}</button>`).join("")}
         </div>
       </div>`;

  return `
    ${
      view.notice
        ? `<div class="notice-row">
             <p class="notice">${escapeHtml(view.notice)}</p>
             ${view.undo?.length ? `<button id="undo" class="link">Undo</button>` : ""}
           </div>`
        : ""
    }
    <div id="compose" class="compose">
      <textarea id="text-input" rows="2" placeholder="Add an event or ask a question…" ${view.busy ? "disabled" : ""}>${escapeHtml(inputText)}</textarea>
      ${fileChip}
      <div class="compose-toolbar">
        <div class="compose-toolbar-left">
          <button id="attach-btn" type="button" class="icon-btn" title="Attach a screenshot, photo, or PDF" aria-label="Attach a file" ${view.busy ? "disabled" : ""}>${ICON_ATTACH}</button>
          <input id="file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" hidden ${view.busy ? "disabled" : ""} />
          <button id="scan-btn" type="button" class="icon-btn" title="Scan current page for events" aria-label="Scan current page for events" ${view.busy ? "disabled" : ""}>${ICON_SCAN}</button>
        </div>
        <button id="submit" type="button" class="send-btn" title="Send (Ctrl/Cmd+Enter)" aria-label="Send" ${view.busy ? "disabled" : ""}>${view.busy ? "…" : ICON_SEND}</button>
      </div>
      ${chips}
    </div>
    ${renderUpcoming(view)}
  `;
}

const RECURRENCE_FREQ_LABEL: Record<string, string> = {
  DAILY: "day",
  WEEKLY: "week",
  MONTHLY: "month",
  YEARLY: "year",
};

const RECURRENCE_DAY_LABEL: Record<string, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
};

// Turns an iCalendar UTC basic-format datetime ("20261126T180000Z") into a
// short local-date label ("Nov 26") — same rendering convention as
// formatEventTime, which also displays in the browser's local timezone.
function formatIcalDateShort(value: string): string {
  const iso = value.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
    "$1-$2-$3T$4:$5:$6Z",
  );
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Turns the recurrence lines (RFC 5545) into a short human-readable summary
// for the confirm list — not a full renderer, just enough for the common
// cases the extraction schema actually produces (an RRULE with
// FREQ/INTERVAL/BYDAY/COUNT/UNTIL, plus an optional EXDATE line).
function formatRecurrence(lines: string[]): string {
  const rule = lines[0];
  const parts = Object.fromEntries(
    rule
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );

  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const freqWord = RECURRENCE_FREQ_LABEL[parts.FREQ] ?? parts.FREQ?.toLowerCase() ?? "time";
  let label = `Every ${interval > 1 ? `${interval} ` : ""}${freqWord}${interval > 1 ? "s" : ""}`;

  if (parts.BYDAY) {
    label += ` on ${parts.BYDAY.split(",")
      .map((day) => RECURRENCE_DAY_LABEL[day] ?? day)
      .join(", ")}`;
  }
  if (parts.COUNT) label += `, ${parts.COUNT} times`;
  else if (parts.UNTIL) {
    label += ` until ${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`;
  }

  const exdateLine = lines.find((line) => line.startsWith("EXDATE"));
  if (exdateLine) {
    const dates = exdateLine
      .replace(/^EXDATE(;[^:]*)?:/, "")
      .split(",")
      .map(formatIcalDateShort);
    label += `, except ${dates.join(", ")}`;
  }
  return label;
}

function renderEditableFields(action: Extract<EventAction, { type: "create" | "update" }>, i: number): string {
  const c = action.candidate;
  const originalNote =
    action.type === "update"
      ? `<p class="action-original">Currently: ${escapeHtml(action.original.title)} — ${escapeHtml(formatEventTime(action.original.start, action.original.end))}</p>`
      : "";
  const recurrenceNote =
    action.type === "create" && c.recurrence?.length
      ? `<p class="recurrence-note">🔁 ${escapeHtml(formatRecurrence(c.recurrence))}</p>`
      : "";
  return `
    ${originalNote}
    <input type="text" class="cand-title" data-index="${i}" value="${escapeAttr(c.title)}" />
    <div class="candidate-times">
      <input type="datetime-local" class="cand-start" data-index="${i}" value="${toDatetimeLocalValue(c.start)}" />
      <span>–</span>
      <input type="datetime-local" class="cand-end" data-index="${i}" value="${toDatetimeLocalValue(c.end)}" />
    </div>
    ${recurrenceNote}
  `;
}

function renderConfirming(view: Extract<View, { kind: "confirming" }>): string {
  const actionType = view.actions[0]?.action.type ?? "create";

  const rows = view.actions
    .map((item, i) => {
      const { action } = item;
      const fields =
        action.type === "delete"
          ? `<p class="action-delete">Cancel "${escapeHtml(action.original.title)}" — ${escapeHtml(formatEventTime(action.original.start, action.original.end))}</p>`
          : renderEditableFields(action, i);
      const conflictNote =
        action.type === "create" && item.conflicts?.length
          ? `<p class="conflict-warning">⚠ Overlaps "${escapeHtml(item.conflicts[0].title)}"${item.conflicts.length > 1 ? ` +${item.conflicts.length - 1} more` : ""}</p>`
          : "";
      return `
      <div class="candidate" data-index="${i}">
        <label class="candidate-select">
          <input type="checkbox" class="cand-selected" data-index="${i}" ${item.selected ? "checked" : ""} />
        </label>
        <div class="candidate-fields">
          ${fields}
          ${conflictNote}
        </div>
      </div>`;
    })
    .join("");

  const selectedCount = view.actions.filter((a) => a.selected).length;

  const leadText =
    actionType === "delete"
      ? view.actions.length > 1
        ? `${view.actions.length} matching events found — review before canceling.`
        : "Review before canceling."
      : actionType === "update"
        ? view.actions.length > 1
          ? `${view.actions.length} matching events found — review the change before updating.`
          : "Review the change before updating."
        : view.actions.length > 1
          ? `${view.actions.length} events found — review before adding.`
          : "Review before adding.";

  const confirmVerb = actionType === "delete" ? "Cancel" : actionType === "update" ? "Update" : "Add";
  const confirmBusyLabel =
    actionType === "delete" ? "Canceling…" : actionType === "update" ? "Updating…" : "Adding…";
  // "Cancel" is the confirm verb for a delete row, so the dismiss link uses
  // a different word there to avoid two same-labeled buttons.
  const dismissLabel = actionType === "delete" ? "Back" : "Cancel";

  return `
    <p class="lead">${leadText}</p>
    <div class="candidates">${rows}</div>
    ${view.error ? `<p class="notice error">${escapeHtml(view.error)}</p>` : ""}
    <div class="confirm-actions">
      <button id="cancel" class="link" ${view.busy ? "disabled" : ""}>${dismissLabel}</button>
      <button id="confirm" class="primary" ${view.busy || selectedCount === 0 ? "disabled" : ""}>
        ${view.busy ? confirmBusyLabel : `${confirmVerb} ${selectedCount} event${selectedCount === 1 ? "" : "s"}`}
      </button>
    </div>
  `;
}

function renderAnswer(view: Extract<View, { kind: "answer" }>): string {
  return `
    <p class="answer">${escapeHtml(view.text).replace(/\n/g, "<br />")}</p>
    <button id="new-query" class="primary">New search</button>
  `;
}

function render() {
  if (!root) return;

  switch (state.kind) {
    case "loading":
      root.innerHTML = `<p class="lead">Loading…</p>`;
      break;
    case "unauthenticated":
      root.innerHTML = renderUnauthenticated(state);
      break;
    case "ready":
      root.innerHTML = renderReady(state);
      break;
    case "confirming":
      root.innerHTML = renderConfirming(state);
      break;
    case "answer":
      root.innerHTML = renderAnswer(state);
      break;
  }

  const headerActions = document.getElementById("header-actions");
  if (headerActions) headerActions.innerHTML = state.kind === "ready" ? renderHeaderActions(state) : "";

  attachHandlers();
}

function autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

const ACCEPTED_FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

function attachHandlers() {
  if (state.kind === "unauthenticated") {
    document.getElementById("connect")?.addEventListener("click", handleConnect);
  }

  if (state.kind === "ready") {
    const current = state;
    document.getElementById("signout")?.addEventListener("click", handleSignOut);
    document.getElementById("settings-icon")?.addEventListener("click", () => handleOpenSettings(current));
    document.getElementById("avatar-btn")?.addEventListener("click", () => {
      avatarMenuOpen = !avatarMenuOpen;
      render();
    });
    // Google photo URLs are usually reliable, but fall back to the letter
    // avatar underneath rather than showing a broken-image icon.
    document.getElementById("avatar-img")?.addEventListener("error", (e) => {
      (e.target as HTMLElement).style.display = "none";
    });
    document.getElementById("submit")?.addEventListener("click", () => handleSubmit(current));
    document.getElementById("scan-btn")?.addEventListener("click", () => handleDetectPage(current));
    document.getElementById("undo")?.addEventListener("click", () => handleUndo(current));
    document.getElementById("remove-file")?.addEventListener("click", () => {
      revokeThumb();
      setState({ ...current, pendingFile: undefined });
    });

    const thumb = document.getElementById("file-thumb") as HTMLImageElement | null;
    if (thumb && current.pendingFile) {
      revokeThumb();
      pendingFileThumbUrl = URL.createObjectURL(current.pendingFile);
      thumb.src = pendingFileThumbUrl;
    }

    const textInput = document.getElementById("text-input") as HTMLTextAreaElement | null;
    if (textInput) autoResizeTextarea(textInput);
    textInput?.addEventListener("input", (e) => {
      const el = e.target as HTMLTextAreaElement;
      inputText = el.value;
      autoResizeTextarea(el);
      persistDraft(state);
    });
    textInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit(current);
      }
    });
    textInput?.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            revokeThumb();
            setState({ ...current, pendingFile: file });
          }
          return;
        }
      }
    });

    const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
    document.getElementById("attach-btn")?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) {
        revokeThumb();
        setState({ ...current, pendingFile: file });
      }
    });

    document.querySelectorAll<HTMLButtonElement>(".chip").forEach((el) => {
      el.addEventListener("click", () => {
        inputText = el.textContent ?? "";
        if (textInput) {
          textInput.value = inputText;
          autoResizeTextarea(textInput);
          textInput.focus();
        }
        persistDraft(state);
      });
    });

    const compose = document.getElementById("compose");
    if (compose && !current.busy) {
      let dragDepth = 0;
      compose.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth += 1;
        compose.classList.add("drag-active");
      });
      compose.addEventListener("dragover", (e) => e.preventDefault());
      compose.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) compose.classList.remove("drag-active");
      });
      compose.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        compose.classList.remove("drag-active");
        const file = e.dataTransfer?.files?.[0];
        if (file && ACCEPTED_FILE_TYPES.includes(file.type)) {
          revokeThumb();
          setState({ ...current, pendingFile: file });
        }
      });
    }
  }

  if (state.kind === "confirming") {
    const current = state;
    document.getElementById("cancel")?.addEventListener("click", () => {
      enterReady(current.email);
    });
    document.getElementById("confirm")?.addEventListener("click", () => handleConfirm(current));

    document.querySelectorAll<HTMLInputElement>(".cand-selected").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const actions = current.actions.map((item, idx) =>
          idx === i ? { ...item, selected: el.checked } : item,
        );
        setState({ ...current, actions });
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-title").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const actions = current.actions.map((item, idx) =>
          idx === i ? { ...item, action: withCandidatePatch(item.action, { title: el.value }) } : item,
        );
        setState({ ...current, actions });
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-start").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const actions = current.actions.map((item, idx) =>
          idx === i
            ? {
                ...item,
                action: withCandidatePatch(item.action, { start: fromDatetimeLocalValue(el.value) }),
                conflicts: undefined,
              }
            : item,
        );
        setState({ ...current, actions });
        recheckConflicts(actions);
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-end").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const actions = current.actions.map((item, idx) =>
          idx === i
            ? {
                ...item,
                action: withCandidatePatch(item.action, { end: fromDatetimeLocalValue(el.value) }),
                conflicts: undefined,
              }
            : item,
        );
        setState({ ...current, actions });
        recheckConflicts(actions);
      });
    });
  }

  if (state.kind === "answer") {
    const current = state;
    document.getElementById("new-query")?.addEventListener("click", () => {
      enterReady(current.email);
    });
  }
}

render();
init();
