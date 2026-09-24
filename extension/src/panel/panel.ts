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

interface ConfirmingState {
  actions: EditableAction[];
  error?: string;
  // What was actually typed/scanned to produce this review — shown as a
  // quiet "You said" line so the context isn't lost once the compose box
  // clears itself for the next message.
  submittedText?: string;
}

// confirming/answer live as optional fields on the ready view (rather than
// their own view kinds) so they render inline below the compose box instead
// of replacing the whole panel — compose, the notice/undo row, and the
// account header all stay live and visible while one is showing.
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
      noticeError?: boolean;
      undo?: EventAction[];
      calendarLabel?: string;
      upcomingEvents?: CalendarEvent[];
      upcomingLoading?: boolean;
      confirming?: ConfirmingState;
      answer?: string;
      // Only ever the events `answer`'s text is a rendering of (see
      // handleParsed) — when present, renderAnswer shows the same tiles as
      // the upcoming-events list instead of a plain bullet-point paragraph.
      answerEvents?: CalendarEvent[];
      // What was asked to produce `answer` — same "You said" purpose as
      // ConfirmingState.submittedText.
      answerQuery?: string;
    };

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
const ICON_CLEAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_CALENDAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

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

// Applies a view change triggered by data written elsewhere (the
// background script's right-click "Add selection" flow) rather than by
// this panel's own actions. Deliberately skips persistDraft — the source
// of truth in chrome.storage was just written by the other side, so
// persisting it again would just re-trigger the storage.onChanged
// listener below for no reason.
function applyExternalState(next: View): void {
  state = next;
  render();
}

// init() reads chrome.storage once, at startup, so it only ever catches a
// draft that was already there when the panel opened. That's fine for a
// panel that was closed and just opened fresh, but the whole point of a
// persistent side panel is that it's usually already open — so the
// right-click "Add selection" flow (background.ts) needs a way to reach a
// panel that's already running. It writes to the same `draft` key this
// panel already persists its own state to, marked with `source:
// "selection"` to tell the two apart; a plain reopen still restores an
// unmarked draft via init() exactly as before.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.draft) return;
  const draft = changes.draft.newValue;
  if (draft?.source !== "selection" || state.kind !== "ready") return;
  if (draft.kind === "confirming" && Array.isArray(draft.actions) && draft.actions.length > 0) {
    applyExternalState({
      ...state,
      confirming: { actions: draft.actions },
      answer: undefined,
      answerEvents: undefined,
      notice: undefined,
      noticeError: undefined,
    });
  } else if (draft.kind === "answer" && typeof draft.text === "string") {
    applyExternalState({
      ...state,
      answer: draft.text,
      answerEvents: Array.isArray(draft.events) ? draft.events : undefined,
      confirming: undefined,
      notice: undefined,
      noticeError: undefined,
    });
  } else if (draft.kind === "notice" && typeof draft.text === "string") {
    applyExternalState({ ...state, notice: draft.text, noticeError: true });
  }
});

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
  if (view.kind === "ready" && view.confirming) {
    payload = { kind: "confirming", actions: view.confirming.actions };
  } else if (view.kind === "ready" && view.answer !== undefined) {
    payload = { kind: "answer", text: view.answer, events: view.answerEvents };
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

// "Today" / "Tomorrow" / "Friday" / "Friday, Oct 3" — the heading each
// same-day run of events is grouped under, so the date is stated once
// instead of repeated on every row. Bare weekday names only stay
// unambiguous within the next 6 days (UPCOMING_WINDOW_DAYS is 14, so two
// Fridays can appear in one list) — past that it adds the date too.
function formatGroupHeading(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function formatTimeBadge(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Used in the confirm screen's clickable time summary — "Friday, September
// 25" / "9:00 AM – 9:30 AM" rather than a raw datetime-local field's
// locale-formatted "09/25/2026, 09:00 AM". The actual datetime-local inputs
// stay fully functional underneath; this is just what's shown by default.
function formatHumanDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function formatHumanTimeRange(start: string, end: string): string {
  const startLabel = new Date(start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const endLabel = new Date(end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${startLabel} – ${endLabel}`;
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

// activeTab is granted per-tab, at the moment the user invokes the
// extension (icon click, keyboard shortcut, or context-menu selection) —
// but the whole point of a persistent side panel is that it survives tab
// switches, so by the time "Scan page" is clicked the active tab is very
// often *not* the one activeTab was granted for anymore, and
// executeScript fails silently. This requests a standing per-origin
// permission instead, which — unlike activeTab — doesn't expire when you
// switch tabs. Called only after a plain scan attempt has already failed
// (see handleDetectPage), so the common case where activeTab still
// happens to be valid never shows an extra prompt. Must be reached
// quickly from the click that triggered it — chrome.permissions.request
// needs to run within the browser's "recent user gesture" window, and a
// long chain of awaits before it can cause Chrome to silently refuse.
async function ensureActiveTabAccess(): Promise<boolean> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//.test(tab.url)) return false;
    const origin = `${new URL(tab.url).origin}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

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
function enterReady(
  email: string,
  opts?: {
    notice?: string;
    noticeError?: boolean;
    undo?: EventAction[];
    confirming?: ConfirmingState;
    answer?: string;
    answerEvents?: CalendarEvent[];
  },
): void {
  avatarMenuOpen = false;
  setState({
    kind: "ready",
    email,
    pictureUrl: cachedPictureUrl,
    notice: opts?.notice,
    noticeError: opts?.noticeError,
    undo: opts?.undo,
    calendarLabel: cachedCalendarLabel,
    upcomingEvents: cachedUpcoming,
    upcomingLoading: cachedUpcoming === undefined,
    confirming: opts?.confirming,
    answer: opts?.answer,
    answerEvents: opts?.answerEvents,
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
      enterReady(me.email, { confirming: { actions: draft.actions } });
      return;
    }
    if (draft?.kind === "answer" && typeof draft.text === "string") {
      enterReady(me.email, {
        answer: draft.text,
        answerEvents: Array.isArray(draft.events) ? draft.events : undefined,
      });
      return;
    }
    // Written by background.ts's right-click "Add selection" flow when
    // there's nothing better to show — a parse error, or nothing
    // recognizable in the selection — so it's not just a badge glyph
    // nobody saw.
    if (draft?.kind === "notice" && typeof draft.text === "string") {
      // Only ever written for a negative/neutral outcome (see
      // background.ts's context-menu handler) — success cases arrive as
      // "confirming"/"answer" drafts instead.
      enterReady(me.email, { notice: draft.text, noticeError: true });
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
      noticeError: true,
    });
  }
}

// Shared by the compose box (handleSubmit) and the page-scan button
// (handleDetectPage) — both end up with a ParseResponse to react to, they
// just differ in where the text they sent came from.
async function handleParsed(
  current: Extract<View, { kind: "ready" }>,
  result: ParseResponse,
  submittedText?: string,
) {
  if (result.intent === "query") {
    inputText = "";
    // notice/undo are cleared here (not just left to whatever current had)
    // to match the pre-inline behavior, where switching to a query answer
    // used to mean leaving the ready view entirely and losing them.
    setState({
      ...current,
      pendingFile: undefined,
      busy: false,
      notice: undefined,
      undo: undefined,
      confirming: undefined,
      answer: result.answer ?? "Nothing found.",
      answerEvents: result.queryEvents,
      answerQuery: submittedText,
    });
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
    setState({
      ...current,
      pendingFile: undefined,
      busy: false,
      notice: undefined,
      undo: undefined,
      answer: undefined,
      answerEvents: undefined,
      answerQuery: undefined,
      confirming: { actions: annotated, submittedText },
    });
    return;
  }

  const notice =
    result.intent === "update"
      ? "Couldn't find a matching event to update — try being more specific."
      : result.intent === "delete"
        ? "Couldn't find a matching event to cancel — try being more specific."
        : "Couldn't find an event or question in that — try rephrasing.";
  // Unlike the two branches above, this one used to leave the failed query
  // sitting in the compose box with no obvious way to clear it — matches
  // their inputText reset now that there's nothing left for it to do.
  inputText = "";
  setState({
    ...current,
    pendingFile: undefined,
    busy: false,
    notice,
    noticeError: true,
    confirming: undefined,
    answer: undefined,
    answerEvents: undefined,
    answerQuery: undefined,
  });
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
    noticeError: true,
  });
}

async function handleSubmit(current: Extract<View, { kind: "ready" }>) {
  if (!inputText.trim() && !current.pendingFile) return;
  // Captured before the parse — a file submission has no text to show back,
  // and inputText itself gets cleared once the review screen renders.
  const submittedText = current.pendingFile ? undefined : inputText.trim();
  setState({ ...current, busy: true });
  try {
    const result = current.pendingFile
      ? await parseFile(current.pendingFile)
      : await parseText(inputText.trim());
    await handleParsed(current, result, submittedText);
  } catch (err) {
    handleApiErrorOrElse(current, err);
  }
}

async function handleDetectPage(current: Extract<View, { kind: "ready" }>) {
  setState({ ...current, busy: true, notice: undefined });
  try {
    let pageText = await scanPageText();
    if (!pageText) {
      // Empty could mean a genuinely blank page, or it could mean
      // activeTab no longer covers this tab (see ensureActiveTabAccess) —
      // ask for standing access and retry once before giving up.
      const granted = await ensureActiveTabAccess();
      if (!granted) {
        setState({
          ...current,
          busy: false,
          notice: "Allow kinroo to read this page, then try Scan again.",
          noticeError: true,
        });
        return;
      }
      pageText = await scanPageText();
    }
    if (!pageText) {
      setState({ ...current, busy: false, notice: "Couldn't read any text on this page.", noticeError: true });
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
    if (state.kind === "ready" && state.confirming) {
      setState({ ...state, confirming: { ...state.confirming, actions: annotated } });
    }
  });
}

// "delete" actions have no candidate to patch — a no-op there is fine since
// no editable fields render for them.
function withCandidatePatch(
  action: EventAction,
  patch: { title?: string; start?: string; end?: string; location?: string },
): EventAction {
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

async function handleConfirm(current: Extract<View, { kind: "ready" }>) {
  const confirming = current.confirming;
  if (!confirming) return;
  const selected = confirming.actions.filter((a) => a.selected);
  if (selected.length === 0) return;
  setState({ ...current, busy: true, confirming: { ...confirming, error: undefined } });
  try {
    const result = await applyActions(selected.map((a) => a.action));
    const failures = result.events.filter((e) => !e.ok);
    if (failures.length > 0) {
      setState({
        ...current,
        busy: false,
        confirming: {
          ...confirming,
          error: `${failures.length} of ${selected.length} change(s) failed to save. Try again?`,
        },
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
      confirming: { ...confirming, error: err instanceof Error ? err.message : "Something went wrong" },
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

// One example per capability (create, query, modify, cancel) — cycled in the
// compose hint below, not shown as clickable chips. Order matters: this is
// the first thing a new user reads, so it leads with the most common case.
const EXAMPLE_PROMPTS = [
  "Dentist appointment tomorrow at 3pm",
  "What's on my calendar Saturday?",
  "Move my 3pm meeting to 4pm",
  "Cancel my dentist appointment",
];
const EXAMPLE_ROTATE_MS = 4000;
// Matches the CSS transition duration on .compose-hint-example — the text
// swap happens at the fade's midpoint so it's never visible mid-crossfade.
const EXAMPLE_FADE_MS = 200;
let exampleIndex = 0;

// Ticks forever at module scope (like the tab-selection listeners below)
// rather than being started/stopped per render — cheap to no-op via the
// getElementById check when the hint isn't currently showing (user typing,
// or on a different screen entirely), and avoids interval lifecycle
// bookkeeping tied to render() calls.
function tickExampleRotation(): void {
  const el = document.getElementById("compose-hint-example");
  if (!el) return;
  el.classList.add("fade-out");
  window.setTimeout(() => {
    exampleIndex = (exampleIndex + 1) % EXAMPLE_PROMPTS.length;
    const current = document.getElementById("compose-hint-example");
    if (!current) return;
    current.textContent = EXAMPLE_PROMPTS[exampleIndex];
    current.classList.remove("fade-out");
  }, EXAMPLE_FADE_MS);
}
setInterval(tickExampleRotation, EXAMPLE_ROTATE_MS);

// Shared with renderAnswer — a query answer ("what's on Saturday?", "list my
// next 10 events") is the same shape of data as the upcoming-events list, so
// it gets the same tiles instead of a plain bullet-point paragraph.
// Groups consecutive same-day events under one heading instead of repeating
// the date on every row — relies on events already arriving in chronological
// order (both callers get that for free from the Calendar API / listEvents).
function renderEventTiles(events: CalendarEvent[]): string {
  const groups: Array<{ heading: string; events: CalendarEvent[] }> = [];
  for (const event of events) {
    const heading = formatGroupHeading(event.start);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.heading === heading) {
      lastGroup.events.push(event);
    } else {
      groups.push({ heading, events: [event] });
    }
  }

  return groups
    .map(
      (group) => `
        <div class="upcoming-group">
          <p class="upcoming-group-heading">${escapeHtml(group.heading)}</p>
          ${group.events
            .map(
              (event) => `
            <div class="upcoming-row" title="${escapeAttr(formatEventTime(event.start, event.end))}${event.location ? ` · ${escapeAttr(event.location)}` : ""}">
              <span class="upcoming-row-time">${escapeHtml(formatTimeBadge(event.start))}</span>
              <span class="upcoming-row-title">${escapeHtml(event.title)}${event.location ? `<span class="upcoming-row-location"> · ${escapeHtml(event.location)}</span>` : ""}</span>
            </div>`,
            )
            .join("")}
        </div>`,
    )
    .join("");
}

function renderUpcoming(view: Extract<View, { kind: "ready" }>): string {
  const body = view.upcomingLoading
    ? `<p class="upcoming-empty">Loading…</p>`
    : !view.upcomingEvents?.length
      ? `<p class="upcoming-empty">Nothing on your calendar for the next two weeks.</p>`
      : renderEventTiles(view.upcomingEvents);
  return `
    <div class="below-compose upcoming">
      <p class="upcoming-heading">Upcoming</p>
      ${body}
    </div>
  `;
}

// Rendered into the static #header-actions slot in panel.html (empty for
// every other view) — an icon cluster instead of raw email/calendar text,
// which used to cost ~30px of vertical space on every single screen.
// "Open Google Calendar" lives here (rather than under the upcoming-events
// list, where it used to be) so it stays reachable no matter which of the
// three below-compose slots — upcoming, confirm, or answer — is showing.
function renderHeaderActions(view: Extract<View, { kind: "ready" }>): string {
  const initial = view.email.trim().charAt(0).toUpperCase() || "?";
  return `
    <a id="open-calendar" class="icon-btn" href="https://calendar.google.com/calendar/r" target="_blank" rel="noopener" title="Open Google Calendar" aria-label="Open Google Calendar">${ICON_CALENDAR}</a>
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

  // The hint teaches the product without competing for attention: it's only
  // useful before you've typed anything and before a confirm/answer is
  // already occupying the slot below — once either is true it'd just be
  // idle "What's on your mind?" chrome sitting above real content.
  const hasFollowup = Boolean(view.confirming) || view.answer !== undefined;
  const showHint = !inputText.trim() && !hasFollowup;

  // Confirm and answer take over the same slot upcoming events normally
  // occupy — only one of the three shows at a time, right below compose,
  // instead of replacing the whole panel the way separate views used to.
  const followup = view.confirming
    ? `<div class="below-compose confirm-block">${renderConfirming(view.confirming, view.busy, view.calendarLabel)}</div>`
    : view.answer !== undefined
      ? `<div class="below-compose answer-block">${renderAnswer(view.answer, view.answerEvents, view.answerQuery)}</div>`
      : renderUpcoming(view);

  return `
    ${
      view.notice
        ? `<div class="notice-row">
             <p class="notice${view.noticeError ? " error" : " success"}">${view.noticeError ? "" : `<span class="notice-icon">${ICON_CHECK}</span>`}${escapeHtml(view.notice)}</p>
             ${view.undo?.length ? `<button id="undo" class="link">Undo</button>` : ""}
             <button id="notice-dismiss" class="link" aria-label="Dismiss">Dismiss</button>
           </div>`
        : ""
    }
    <div id="compose" class="compose">
      <div class="compose-input-wrap">
        <textarea id="text-input" rows="2" placeholder="" aria-label="Add an event or ask a question" ${view.busy ? "disabled" : ""}>${escapeHtml(inputText)}</textarea>
        <div id="compose-hint" class="compose-hint" aria-hidden="true" style="${showHint ? "" : "display:none;"}">
          <span class="compose-hint-title">What's on your mind?</span>
          <span id="compose-hint-example" class="compose-hint-example">${escapeHtml(EXAMPLE_PROMPTS[exampleIndex])}</span>
        </div>
      </div>
      ${fileChip}
      <div class="compose-toolbar">
        <div class="compose-toolbar-left">
          <button id="attach-btn" type="button" class="icon-btn" title="Attach a screenshot, photo, or PDF" aria-label="Attach a file" ${view.busy ? "disabled" : ""}>${ICON_ATTACH}</button>
          <input id="file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" hidden ${view.busy ? "disabled" : ""} />
          <button id="scan-btn" type="button" class="icon-btn" title="Scan the current page for events" aria-label="Scan the current page for events" ${view.busy ? "disabled" : ""}>${ICON_SCAN}</button>
          <button id="clear-btn" type="button" class="icon-btn" title="Clear text" aria-label="Clear text" ${view.busy ? "disabled" : ""} style="${inputText.trim() ? "" : "display:none;"}">${ICON_CLEAR}</button>
        </div>
        <button id="submit" type="button" class="send-btn" title="Send (Ctrl/Cmd+Enter)" aria-label="Send" ${view.busy ? "disabled" : ""}>${view.busy ? "…" : ICON_SEND}</button>
      </div>
    </div>
    ${followup}
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
    <input type="text" class="cand-title candidate-title-input" data-index="${i}" value="${escapeAttr(c.title)}" aria-label="Event title" />
    <div class="candidate-time-edit">
      <button type="button" class="candidate-time-summary" data-index="${i}" aria-label="Edit date and time">
        <span class="candidate-time-date">${escapeHtml(formatHumanDate(c.start))}</span>
        <span class="candidate-time-range">${escapeHtml(formatHumanTimeRange(c.start, c.end))}</span>
      </button>
      <div class="candidate-times">
        <input type="datetime-local" class="cand-start" data-index="${i}" value="${toDatetimeLocalValue(c.start)}" aria-label="Start time" />
        <span>–</span>
        <input type="datetime-local" class="cand-end" data-index="${i}" value="${toDatetimeLocalValue(c.end)}" aria-label="End time" />
      </div>
    </div>
    <input type="text" class="cand-location candidate-location-input" data-index="${i}" value="${escapeAttr(c.location ?? "")}" placeholder="Add location" aria-label="Location" />
    ${recurrenceNote}
  `;
}

// Tile shape (accent stripe, tile background, rounded-right corners) is
// deliberately heavier than the plain upcoming-event rows — a pending
// change needs to stand out as something awaiting a decision, dashed
// instead of solid to signal "not on your calendar yet". A single proposed
// event skips the checkbox (there's
// nothing to select between); two or more keep it so the user can choose
// which ones to act on.
function renderConfirming(
  confirming: ConfirmingState,
  busy: boolean | undefined,
  calendarLabel: string | undefined,
): string {
  const actionType = confirming.actions[0]?.action.type ?? "create";
  const isSingle = confirming.actions.length === 1;

  const rows = confirming.actions
    .map((item, i) => {
      const { action } = item;
      const body =
        action.type === "delete"
          ? `<p class="action-delete">Cancel "${escapeHtml(action.original.title)}" — ${escapeHtml(formatEventTime(action.original.start, action.original.end))}</p>`
          : renderEditableFields(action, i);
      const conflictNote =
        action.type === "create" && item.conflicts?.length
          ? `<p class="conflict-warning">⚠ Overlaps "${escapeHtml(item.conflicts[0].title)}"${item.conflicts.length > 1 ? ` +${item.conflicts.length - 1} more` : ""}</p>`
          : "";
      const checkbox = isSingle
        ? ""
        : `<input type="checkbox" class="cand-selected candidate-checkbox" data-index="${i}" ${item.selected ? "checked" : ""} aria-label="Include this event" />`;
      return `
      <div class="candidate-tile" data-index="${i}">
        ${checkbox}
        <div class="candidate-body">
          ${body}
          ${conflictNote}
        </div>
      </div>`;
    })
    .join("");

  const selectedCount = confirming.actions.filter((a) => a.selected).length;
  const count = confirming.actions.length;

  const leadText =
    actionType === "delete"
      ? isSingle
        ? "Review before canceling."
        : `Review ${count} events to cancel.`
      : actionType === "update"
        ? isSingle
          ? "Review the change before updating."
          : `Review ${count} events to update.`
        : isSingle
          ? "Review before adding."
          : `Review ${count} events`;

  const trustText =
    actionType === "delete"
      ? "Nothing will be canceled without your confirmation."
      : actionType === "update"
        ? "Nothing will be changed without your confirmation."
        : "Nothing will be added without your confirmation.";

  const confirmVerb = actionType === "delete" ? "Cancel" : actionType === "update" ? "Update" : "Add";
  const confirmBusyLabel =
    actionType === "delete" ? "Canceling…" : actionType === "update" ? "Updating…" : "Adding…";
  // "Cancel" is the confirm verb for a delete row, so the dismiss link uses
  // a different word there to avoid two same-labeled buttons.
  const dismissLabel = actionType === "delete" ? "Back" : "Cancel";
  // Never "Add 1 event" — when there's only one candidate total the count is
  // just noise; it's only worth stating once there's something to count.
  const confirmLabel = isSingle
    ? `${confirmVerb} event`
    : `${confirmVerb} ${selectedCount} event${selectedCount === 1 ? "" : "s"}`;

  return `
    ${renderSaidLine(confirming.submittedText)}
    <p class="lead">${leadText}</p>
    <p class="confirm-trust">${trustText}</p>
    <div class="candidates">${rows}</div>
    ${confirming.error ? `<p class="notice error">${escapeHtml(confirming.error)}</p>` : ""}
    <div class="confirm-actions">
      <button id="confirm-dismiss" class="link" ${busy ? "disabled" : ""}>${dismissLabel}</button>
      <button id="confirm" class="primary" ${busy || selectedCount === 0 ? "disabled" : ""}>
        ${busy ? confirmBusyLabel : confirmLabel}
      </button>
    </div>
    ${calendarLabel ? `<p class="confirm-destination">Google Calendar · ${escapeHtml(calendarLabel)}</p>` : ""}
  `;
}

// Quiet reminder of what was actually typed/scanned, since the compose box
// clears itself as soon as a review screen (confirm or answer) takes over
// the slot below it — without this the context you just typed is gone the
// moment you can no longer act on it. Omitted for submissions with nothing
// meaningful to quote back (a file attachment, a page scan).
function renderSaidLine(submittedText: string | undefined): string {
  return submittedText ? `<p class="said-line">You said: "${escapeHtml(submittedText)}"</p>` : "";
}

function renderAnswer(text: string, events: CalendarEvent[] | undefined, submittedText: string | undefined): string {
  const body = events?.length
    ? renderEventTiles(events)
    : `<p class="answer">${escapeHtml(text).replace(/\n/g, "<br />")}</p>`;
  return `
    ${renderSaidLine(submittedText)}
    ${body}
    <button id="answer-dismiss" class="link answer-dismiss">Dismiss</button>
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
  }

  const headerActions = document.getElementById("header-actions");
  if (headerActions) headerActions.innerHTML = state.kind === "ready" ? renderHeaderActions(state) : "";

  attachHandlers();
}

function autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Typing and picking a chip both update inputText without a full render()
// (to avoid re-rendering the compose box on every keystroke), so clear-btn's
// visibility — driven by inputText at render time — needs the same direct
// DOM toggle rather than waiting for the next unrelated re-render.
function syncClearBtn(): void {
  const clearBtn = document.getElementById("clear-btn");
  if (clearBtn) clearBtn.style.display = inputText.trim() ? "" : "none";
}

// Same reasoning as syncClearBtn — typing updates inputText without a full
// render(), so the hint's visibility needs the same direct toggle. Only
// inputText matters here: hasFollowup (the other half of showHint) can't
// change from typing alone, only from a state transition that already goes
// through setState/render.
function syncComposeHint(): void {
  const hint = document.getElementById("compose-hint");
  if (hint) hint.style.display = inputText.trim() ? "none" : "";
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
    document.getElementById("notice-dismiss")?.addEventListener("click", () => {
      setState({ ...current, notice: undefined, noticeError: undefined });
    });
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
    document.getElementById("clear-btn")?.addEventListener("click", () => {
      inputText = "";
      if (textInput) {
        textInput.value = "";
        autoResizeTextarea(textInput);
        textInput.focus();
      }
      persistDraft(state);
      render();
    });
    textInput?.addEventListener("input", (e) => {
      const el = e.target as HTMLTextAreaElement;
      inputText = el.value;
      autoResizeTextarea(el);
      persistDraft(state);
      syncClearBtn();
      syncComposeHint();
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

    if (current.confirming) {
      const confirming = current.confirming;
      // A lightweight local clear rather than enterReady() — nothing about
      // the calendar changed, so there's no need to re-fetch upcoming
      // events or the calendar label just to dismiss.
      document.getElementById("confirm-dismiss")?.addEventListener("click", () => {
        setState({ ...current, confirming: undefined });
      });
      document.getElementById("confirm")?.addEventListener("click", () => handleConfirm(current));

      document.querySelectorAll<HTMLInputElement>(".cand-selected").forEach((el) => {
        el.addEventListener("change", () => {
          const i = Number(el.dataset.index);
          const actions = confirming.actions.map((item, idx) =>
            idx === i ? { ...item, selected: el.checked } : item,
          );
          setState({ ...current, confirming: { ...confirming, actions } });
        });
      });
      // Presentational only — reveals the native datetime-local inputs in
      // place without a full re-render, since nothing about state changes
      // until one of those inputs actually commits. Their own "change"
      // handlers below trigger setState on commit, which re-renders back to
      // summary view for free.
      document.querySelectorAll<HTMLButtonElement>(".candidate-time-summary").forEach((el) => {
        el.addEventListener("click", () => {
          const wrap = el.closest(".candidate-time-edit");
          wrap?.classList.add("editing");
          wrap?.querySelector<HTMLInputElement>(".cand-start")?.focus();
        });
      });
      document.querySelectorAll<HTMLInputElement>(".cand-title").forEach((el) => {
        el.addEventListener("change", () => {
          const i = Number(el.dataset.index);
          const actions = confirming.actions.map((item, idx) =>
            idx === i ? { ...item, action: withCandidatePatch(item.action, { title: el.value }) } : item,
          );
          setState({ ...current, confirming: { ...confirming, actions } });
        });
      });
      document.querySelectorAll<HTMLInputElement>(".cand-location").forEach((el) => {
        el.addEventListener("change", () => {
          const i = Number(el.dataset.index);
          const actions = confirming.actions.map((item, idx) =>
            idx === i ? { ...item, action: withCandidatePatch(item.action, { location: el.value }) } : item,
          );
          setState({ ...current, confirming: { ...confirming, actions } });
        });
      });
      document.querySelectorAll<HTMLInputElement>(".cand-start").forEach((el) => {
        el.addEventListener("change", () => {
          const i = Number(el.dataset.index);
          const actions = confirming.actions.map((item, idx) =>
            idx === i
              ? {
                  ...item,
                  action: withCandidatePatch(item.action, { start: fromDatetimeLocalValue(el.value) }),
                  conflicts: undefined,
                }
              : item,
          );
          setState({ ...current, confirming: { ...confirming, actions } });
          recheckConflicts(actions);
        });
      });
      document.querySelectorAll<HTMLInputElement>(".cand-end").forEach((el) => {
        el.addEventListener("change", () => {
          const i = Number(el.dataset.index);
          const actions = confirming.actions.map((item, idx) =>
            idx === i
              ? {
                  ...item,
                  action: withCandidatePatch(item.action, { end: fromDatetimeLocalValue(el.value) }),
                  conflicts: undefined,
                }
              : item,
          );
          setState({ ...current, confirming: { ...confirming, actions } });
          recheckConflicts(actions);
        });
      });
    }

    if (current.answer !== undefined) {
      document.getElementById("answer-dismiss")?.addEventListener("click", () => {
        setState({ ...current, answer: undefined, answerEvents: undefined, answerQuery: undefined });
      });
    }
  }
}

render();
init();
