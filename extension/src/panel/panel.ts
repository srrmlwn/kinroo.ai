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
import { addDays, isAllDay, isDateOnly, parseEventDate, toDateValue } from "../dates";
import type {
  EventAction,
  EventCandidate,
  EditableAction,
  ParseResponse,
  CalendarEvent,
  CreateEventsResponse,
} from "../types";

interface ConfirmingState {
  actions: EditableAction[];
  error?: string;
  // What was actually typed/scanned to produce this review — shown as a
  // quiet "You said" line so the context isn't lost once the compose box
  // clears itself for the next message.
  submittedText?: string;
  // Accumulated across confirm attempts when only some rows go through, so
  // the eventual success notice (or backing out after a partial save) can
  // still offer one Undo that covers everything that actually landed.
  savedUndo?: EventAction[];
  savedIds?: string[];
  // Set once the user edits a field or changes the selection — the point
  // after which replacing this review with a new message would lose work,
  // so sending one asks first (see handleSubmit).
  dirty?: boolean;
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
      // What the panel is doing while busy ("Reading the file…") — the only
      // progress signal a parse gets, so it's worded, not a bare spinner.
      busyLabel?: string;
      // Which kind of parse is running (typed text, a file, a page scan) —
      // drives the slow-parse hint's wording and whether Cancel is offered.
      busyKind?: "text" | "file" | "page";
      // Sending a new message while an edited review is up asks before
      // discarding it (see handleSubmit).
      replacePrompt?: boolean;
      notice?: string;
      noticeError?: boolean;
      noticeLink?: { href: string; label: string };
      undo?: EventAction[];
      calendarLabel?: string;
      upcomingEvents?: CalendarEvent[];
      upcomingLoading?: boolean;
      // Events just added/updated — marked once in the upcoming list so the
      // result of a confirm is visible where you'd look for it, then cleared.
      highlightIds?: string[];
      confirming?: ConfirmingState;
      answer?: string;
      // Only ever the events `answer`'s text is a rendering of (see
      // handleParsed) — when present, renderAnswer shows the same tiles as
      // the upcoming-events list instead of a plain bullet-point paragraph.
      answerEvents?: CalendarEvent[];
      // "Yes." / "No." for a yes/no question, shown ahead of the answer.
      answerLead?: string;
      // What was asked to produce `answer` — same "You said" purpose as
      // ConfirmingState.submittedText.
      answerQuery?: string;
    };

type ReadyView = Extract<View, { kind: "ready" }>;

let state: View = { kind: "loading" };
let inputText = "";
let avatarMenuOpen = false;
// A selector to move focus to after the next render — set by transitions
// that destroy the focused element (confirming, dismissing, opening the
// account menu) so keyboard and screen-reader users land somewhere sensible
// instead of on <body>.
let pendingFocus: string | null = null;

// Minimal inline icons (Feather-style: 24x24, stroke=currentColor) — no
// icon library dependency for a handful of glyphs.
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON_ATTACH = svg('<path d="M21.44 11.05L12.25 20.24a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>');
const ICON_SEND = svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>');
const ICON_PAGE = svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>');
const ICON_SETTINGS = svg('<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2" fill="currentColor" stroke="none"/>');
const ICON_CLEAR = svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
// Clearing typed text uses a backspace key, so it can't be mistaken for
// the X that dismisses a message.
const ICON_BACKSPACE = svg('<path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>');
const ICON_CALENDAR = svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>');
const ICON_CHECK = svg('<polyline points="20 6 9 17 4 12"/>');
const ICON_REPEAT = svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/>');
const ICON_ALERT = svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
const ICON_EDIT = svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/>');
const ICON_GLOBE = svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>');
const SPINNER = `<span class="spinner" aria-hidden="true"></span>`;

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

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const root = document.getElementById("root");
if (!root) throw new Error("panel root element missing");

function setState(next: View) {
  if (next.kind === "ready" && next.busy && !(state.kind === "ready" && state.busy)) {
    busyStartedAt = Date.now();
  }
  state = next;
  persistDraft(next);
  render();
}

// For edits made *inside* the confirm card (title, location, times). Those
// commit on every keystroke/change and must not re-render: a full render
// replaces the very input being edited, which used to drop focus to <body>
// after every edit and, worse, swallow the click on "Add event" when an
// edit was committed by that same click's mousedown.
function commitState(next: View) {
  state = next;
  persistDraft(next);
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

// Screen readers get told about everything that appears without focus
// moving to it — a parse result, a conflict, a saved/undone notice. Two
// regions (in panel.html, outside #root so re-renders never destroy them):
// polite for progress and results, assertive for errors.
function announce(message: string, urgent = false): void {
  const region = document.getElementById(urgent ? "live-alert" : "live-status");
  if (!region) return;
  region.textContent = "";
  // Cleared and re-set a beat later so repeating the same message
  // ("Couldn't save.") is still announced the second time. A timer, not
  // requestAnimationFrame — rAF doesn't fire while the panel is hidden,
  // and a message queued then would never be read.
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
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
      answerLead: typeof draft.lead === "string" ? draft.lead : undefined,
      confirming: undefined,
      notice: undefined,
      noticeError: undefined,
    });
  } else if (draft.kind === "notice" && typeof draft.text === "string") {
    applyExternalState({ ...state, notice: draft.text, noticeError: true });
  } else if (draft.kind === "ready" && typeof draft.inputText === "string") {
    // The right-click "Add selection" flow (background.ts) — pastes the
    // selection into the compose box for review/editing rather than
    // parsing it immediately, same as every other input path.
    inputText = draft.inputText;
    pendingFocus = "#text-input";
    applyExternalState({
      ...state,
      confirming: undefined,
      answer: undefined,
      answerEvents: undefined,
      notice: undefined,
      noticeError: undefined,
    });
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
//
// Only the ready view writes here: an expired session drops to the
// unauthenticated view, and wiping the draft at that moment used to throw
// away a half-reviewed confirm list just because a token lapsed. Sign-out
// clears it explicitly instead (see handleSignOut).
function persistDraft(view: View) {
  if (view.kind !== "ready") return;
  const payload = view.confirming
    ? { kind: "confirming", actions: view.confirming.actions }
    : view.answer !== undefined
      ? { kind: "answer", text: view.answer, events: view.answerEvents, lead: view.answerLead }
      : { kind: "ready", inputText };
  chrome.storage.local.set({ draft: payload }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

function toDatetimeLocalValue(iso: string): string {
  const d = parseEventDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string {
  return value ? new Date(value).toISOString() : "";
}

// Mirrors the server's isCandidateComplete: a parse can leave title/start/end
// empty when the source never stated them, and the confirm button stays
// disabled until the user fills them in.
function isCandidateComplete(candidate: EventCandidate): boolean {
  return candidate.title.trim() !== "" && hasTimes(candidate);
}

function hasTimes(candidate: EventCandidate): boolean {
  return !Number.isNaN(Date.parse(candidate.start)) && !Number.isNaN(Date.parse(candidate.end));
}

function isActionComplete(action: EventAction): boolean {
  return action.type === "delete" || isCandidateComplete(action.candidate);
}

const FALLBACK_DURATION_MS = 60 * 60_000;

// A start edit leaves the end alone while it's still after the new start.
// Otherwise (the start moved past it, or the event had no times at all yet)
// the end follows the start, keeping the event's length or defaulting to an
// hour, so setting a start is enough to make the event saveable.
function endForNewStart(candidate: EventCandidate, newStart: string): string {
  const newStartMs = Date.parse(newStart);
  if (Number.isNaN(newStartMs)) return candidate.end;
  const oldEndMs = Date.parse(candidate.end);
  if (!Number.isNaN(oldEndMs) && oldEndMs > newStartMs) return candidate.end;
  const oldStartMs = Date.parse(candidate.start);
  const duration =
    !Number.isNaN(oldStartMs) && !Number.isNaN(oldEndMs) && oldEndMs > oldStartMs
      ? oldEndMs - oldStartMs
      : FALLBACK_DURATION_MS;
  return new Date(newStartMs + duration).toISOString();
}

// Non-breaking spaces so a narrow panel never wraps "3:00 / PM".
function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// "Today" / "Tomorrow" / "Friday" / "Friday, Oct 3" — the heading each
// same-day run of events is grouped under, so the date is stated once
// instead of repeated on every row. Bare weekday names only stay
// unambiguous within the next 6 days (UPCOMING_WINDOW_DAYS is 14, so two
// Fridays can appear in one list) — past that it adds the date too. Query
// answers can reach into the past, hence "Yesterday".
function formatGroupHeading(iso: string): string {
  const date = parseEventDate(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(date) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function formatTimeBadge(event: CalendarEvent): string {
  return isAllDay(event) ? "All day" : formatClock(parseEventDate(event.start));
}

// Used in the confirm screen's clickable time summary — "Friday, September
// 25" / "9:00 AM – 9:30 AM" rather than a raw datetime-local field's
// locale-formatted "09/25/2026, 09:00 AM". The actual datetime-local inputs
// stay fully functional underneath; this is just what's shown by default.
// One date format everywhere a specific day is named ("Fri, Sep 25") — it
// fits a 320px panel and never disagrees with itself across screens.
function formatHumanDate(iso: string): string {
  return formatShortDate(parseEventDate(iso));
}

// All-day ends are exclusive in Google's model (a one-day event on the
// 27th ends on the 28th), so the last day shown is end minus one.
function lastAllDay(end: string): Date {
  return parseEventDate(addDays(end, -1));
}

function formatHumanTimeRange(start: string, end: string): string {
  if (isDateOnly(start)) {
    const last = lastAllDay(end);
    return last > parseEventDate(start) ? `All day, through ${formatShortDate(last)}` : "All day";
  }
  const s = parseEventDate(start);
  const e = parseEventDate(end);
  const endLabel = s.toDateString() === e.toDateString() ? formatClock(e) : `${formatShortDate(e)}, ${formatClock(e)}`;
  return `${formatClock(s)} – ${endLabel}`;
}

function formatEventTime(start: string, end: string): string {
  if (isDateOnly(start)) {
    const s = parseEventDate(start);
    const lastDay = lastAllDay(end);
    return lastDay > s ? `${formatShortDate(s)} – ${formatShortDate(lastDay)} · all day` : `${formatShortDate(s)} · all day`;
  }
  return `${formatShortDate(parseEventDate(start))}, ${formatHumanTimeRange(start, end)}`;
}

// Google Calendar's own day view — the one link into Calendar that works
// for any account and calendar without knowing the event's encoded id.
function calendarDayUrl(iso: string): string {
  const d = parseEventDate(iso);
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Page access
// ---------------------------------------------------------------------------

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

// Panel-wide keys. Escape backs out of whatever is on top — the account
// menu, an open time editor, then the review/answer/notice — but only when
// focus is in that area or nowhere, so Escape while typing a new message
// never throws away a review sitting below it. Ctrl/Cmd+Enter inside the
// review confirms it, matching the compose box's own send shortcut.
document.addEventListener("keydown", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (e.key === "Escape") {
    if (avatarMenuOpen) {
      e.preventDefault();
      avatarMenuOpen = false;
      pendingFocus = "#avatar-btn";
      render();
      return;
    }
    const editor = target?.closest<HTMLElement>(".candidate-time-edit.editing");
    if (editor) {
      e.preventDefault();
      editor.classList.remove("editing");
      editor.querySelector<HTMLElement>(".candidate-time-summary")?.focus();
      return;
    }
    if (state.kind !== "ready") return;
    if (state.replacePrompt) {
      e.preventDefault();
      pendingFocus = "#review-heading";
      setState({ ...state, replacePrompt: undefined });
      return;
    }
    if (state.busy) return;
    // An empty compose box counts too: nothing typed can be lost.
    const emptyCompose = target?.id === "text-input" && !inputText.trim();
    const inFollowup = !target || target === document.body || emptyCompose || target.closest(".below-compose, .notice-row");
    if (!inFollowup) return;
    if (state.confirming) {
      e.preventDefault();
      dismissConfirm(state);
    } else if (state.answer !== undefined) {
      e.preventDefault();
      closeAnswer(state);
    } else if (state.notice) {
      e.preventDefault();
      pendingFocus = "#text-input";
      setState({ ...state, notice: undefined, noticeError: undefined, noticeLink: undefined });
    }
    return;
  }
  // Undo from anywhere except a text field (where Cmd/Ctrl+Z already
  // means "undo my typing").
  if (e.key.toLowerCase() === "z" && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
    const editable = target?.closest("input, textarea, [contenteditable='true']");
    if (!editable && state.kind === "ready" && state.undo?.length && !state.busy) {
      e.preventDefault();
      handleUndo(state);
    }
    return;
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && target?.closest(".confirm-block")) {
    if (state.kind === "ready" && state.confirming && !state.busy) {
      e.preventDefault();
      handleConfirm(state);
    }
  }
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

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

const UPCOMING_WINDOW_DAYS = 14;
const UPCOMING_LIMIT = 5;

// Keeps the whole two-week window (not just the first 5) so the list can
// say how many more there are instead of silently stopping.
async function fetchUpcoming(): Promise<CalendarEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const { events } = await getEvents(now.toISOString(), end.toISOString());
  return events;
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
    noticeLink?: { href: string; label: string };
    undo?: EventAction[];
    highlightIds?: string[];
    confirming?: ConfirmingState;
    answer?: string;
    answerEvents?: CalendarEvent[];
    answerLead?: string;
  },
): void {
  avatarMenuOpen = false;
  setState({
    kind: "ready",
    email,
    pictureUrl: cachedPictureUrl,
    notice: opts?.notice,
    noticeError: opts?.noticeError,
    noticeLink: opts?.noticeLink,
    undo: opts?.undo,
    highlightIds: opts?.highlightIds,
    calendarLabel: cachedCalendarLabel,
    upcomingEvents: cachedUpcoming,
    upcomingLoading: cachedUpcoming === undefined,
    confirming: opts?.confirming,
    answer: opts?.answer,
    answerEvents: opts?.answerEvents,
    answerLead: opts?.answerLead,
  });
  if (cachedCalendarLabel === undefined) loadCalendarLabel(email);
  loadUpcoming(email);
}

// Shared by a fresh panel open (init) and a reconnect after an expired
// session (handleConnect) — the draft survives the sign-in round-trip, so
// a half-reviewed confirm list picks up exactly where it was.
async function restoreDraftAndEnter(email: string): Promise<void> {
  const { draft } = await chrome.storage.local.get("draft");
  if (draft?.kind === "confirming" && Array.isArray(draft.actions) && draft.actions.length > 0) {
    enterReady(email, { confirming: { actions: draft.actions } });
    return;
  }
  if (draft?.kind === "answer" && typeof draft.text === "string") {
    enterReady(email, {
      answer: draft.text,
      answerEvents: Array.isArray(draft.events) ? draft.events : undefined,
      answerLead: typeof draft.lead === "string" ? draft.lead : undefined,
    });
    return;
  }
  // Written by background.ts's right-click "Add selection" flow when
  // there's nothing better to show — a parse error, or nothing
  // recognizable in the selection — so it's not just a badge glyph
  // nobody saw. Only ever written for a negative/neutral outcome; success
  // cases arrive as "confirming"/"answer" drafts instead.
  if (draft?.kind === "notice" && typeof draft.text === "string") {
    enterReady(email, { notice: draft.text, noticeError: true });
    return;
  }
  inputText = draft?.kind === "ready" && typeof draft.inputText === "string" ? draft.inputText : "";
  if (!inputText) {
    inputText = await readPageSelection();
  }
  pendingFocus = "#text-input";
  enterReady(email);
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
    await restoreDraftAndEnter(me.email);
  } catch {
    await clearSession();
    setState({ kind: "unauthenticated" });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const SESSION_EXPIRED = "Your Google sign-in expired. Reconnect to pick up where you left off.";
const EXAMPLE_FIX = "Try something like “Lunch with Sam Friday at noon”.";

// Server and network failures, reworded into what happened and what to do
// next. Specific server messages pass through; only the generic ones and
// raw transport failures get replaced.
function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof TypeError) return "Can't reach kinroo. Check your connection and try again.";
  if (err instanceof ApiError) {
    if (err.status === 429) return "That's a lot of requests at once. Wait a moment and try again.";
    if (err.status === 413) return "That file is too large. Try a smaller screenshot or PDF.";
    if (err.status >= 500) return "kinroo ran into a problem on its end. Try again in a moment.";
    if (/^Could not parse that/.test(err.message)) return `Couldn't read that. ${EXAMPLE_FIX}`;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

// Per-row save failures arrive as raw Calendar API text ("Calendar insert
// failed: 403 {...}") — never shown as-is. Each is the reason that follows
// a bold "Didn't save." on the row.
function friendlyRowError(raw: string): string {
  if (/\b403\b/.test(raw)) return "Google didn't allow this change on that calendar.";
  if (/\b(404|410)\b/.test(raw)) return "This event no longer exists in Google Calendar.";
  if (/\b429\b/.test(raw)) return "Google is limiting changes right now. Wait a moment, then retry.";
  if (/\b5\d\d\b/.test(raw)) return "Google Calendar had a temporary problem. Retrying usually works.";
  return "Google didn't say why. Retrying usually works.";
}

function expireSession(): void {
  clearSession().then(() => setState({ kind: "unauthenticated", error: SESSION_EXPIRED }));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleConnect() {
  setState({ kind: "loading" });
  try {
    // Runs in the background worker, not here — chrome.identity's consent
    // window steals focus, and running it there keeps sign-in independent
    // of whether this panel document is even open (see background.ts).
    const result = await chrome.runtime.sendMessage({ type: "connect-google" });
    if (!result?.ok) throw new Error(result?.error ?? "Sign-in didn't finish");
    cachedPictureUrl = result.pictureUrl;
    await restoreDraftAndEnter(result.email);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    pendingFocus = "#connect";
    setState({
      kind: "unauthenticated",
      error: /cancel|closed|did not approve/i.test(message)
        ? "Sign-in was canceled. Connect again whenever you're ready."
        : "Couldn't finish signing in to Google. Try again.",
    });
  }
}

async function handleSignOut() {
  await clearSession();
  await chrome.storage.local.remove("draft").catch(() => {});
  inputText = "";
  cachedCalendarLabel = undefined;
  cachedUpcoming = undefined;
  avatarMenuOpen = false;
  pendingFocus = "#connect";
  setState({ kind: "unauthenticated" });
}

async function handleOpenSettings(current: ReadyView) {
  try {
    const [{ token }, config] = await Promise.all([requestHandoffToken(), getConfig()]);
    await chrome.tabs.create({ url: `${config.apiBase}/api/auth/handoff?token=${encodeURIComponent(token)}` });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      expireSession();
      return;
    }
    const message = friendlyError(err, "Couldn't open settings. Try again.");
    announce(message, true);
    setState({ ...current, notice: message, noticeError: true, noticeLink: undefined });
  }
}

// One sentence a screen reader can say about a fresh review — how many,
// what the first one is, and whether anything clashes.
function describeReview(actions: EditableAction[]): string {
  const first = actions[0];
  const conflicts = actions.filter((a) => a.conflicts?.length).length;
  const summary =
    actions.length === 1
      ? first.action.type === "delete"
        ? `Review: cancel ${first.action.original.title}, ${formatEventTime(first.action.original.start, first.action.original.end)}.`
        : `Review: ${first.action.candidate.title.trim() || "untitled event"}, ${hasTimes(first.action.candidate) ? formatEventTime(first.action.candidate.start, first.action.candidate.end) : "no date yet"}.`
      : `${actions.length} events to review.`;
  const missing = actions.some((a) => !isActionComplete(a.action)) ? " Some details are missing and need filling in." : "";
  const withConflicts = conflicts ? `${summary} ${plural(conflicts, "overlap")} with your calendar.` : summary;
  return withConflicts + missing;
}

// Shared by the compose box (handleSubmit) and the page-scan button
// (handleDetectPage) — both end up with a ParseResponse to react to, they
// just differ in where the text they sent came from.
async function handleParsed(current: ReadyView, result: ParseResponse, submittedText?: string) {
  if (result.intent === "query") {
    inputText = "";
    const answer = result.answer ?? "Nothing found.";
    // notice/undo are cleared here (not just left to whatever current had)
    // to match the pre-inline behavior, where switching to a query answer
    // used to mean leaving the ready view entirely and losing them.
    pendingFocus = "#text-input";
    setState({
      ...current,
      pendingFile: undefined,
      busy: false,
      busyLabel: undefined,
      busyKind: undefined,
      notice: undefined,
      noticeLink: undefined,
      undo: undefined,
      confirming: undefined,
      answer,
      answerEvents: result.queryEvents,
      answerLead: result.answerLead,
      answerQuery: submittedText,
    });
    announce(describeAnswer(answer, result.queryEvents, result.answerLead));
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
    pendingFocus = "#review-heading";
    setState({
      ...current,
      pendingFile: undefined,
      busy: false,
      busyLabel: undefined,
      busyKind: undefined,
      notice: undefined,
      noticeLink: undefined,
      undo: undefined,
      answer: undefined,
      answerEvents: undefined,
      answerQuery: undefined,
      confirming: { actions: annotated, submittedText },
    });
    announce(describeReview(annotated));
    return;
  }

  const notice =
    result.intent === "update"
      ? "Couldn't find the event to change. Include its name or time, like “Move my dentist appointment to 4pm”."
      : result.intent === "delete"
        ? "Couldn't find the event to cancel. Include its name or day, like “Cancel Friday's dentist appointment”."
        : `Couldn't find an event or a question in that. ${EXAMPLE_FIX}`;
  // Unlike the two branches above, this one used to leave the failed query
  // sitting in the compose box with no obvious way to clear it — matches
  // their inputText reset now that there's nothing left for it to do.
  // Typed text stays, though: rewording it beats retyping it.
  if (!submittedText) inputText = "";
  pendingFocus = "#text-input";
  setState({
    ...current,
    pendingFile: undefined,
    busy: false,
    busyLabel: undefined,
    busyKind: undefined,
    notice,
    noticeError: true,
    noticeLink: undefined,
    confirming: undefined,
    answer: undefined,
    answerEvents: undefined,
    answerQuery: undefined,
  });
  announce(notice, true);
}

function handleApiErrorOrElse(current: ReadyView, err: unknown, fallback: string): void {
  if (err instanceof ApiError && err.status === 401) {
    expireSession();
    return;
  }
  const message = friendlyError(err, fallback);
  pendingFocus = "#text-input";
  setState({ ...current, busy: false, busyLabel: undefined, busyKind: undefined, notice: message, noticeError: true, noticeLink: undefined });
  announce(message, true);
}

// The parse currently in flight, so the busy row's Cancel can abandon it.
let activeParse: AbortController | null = null;

// Past this point, replacing the review would throw away something the
// user did — edits, a changed selection, or rows that already saved.
function reviewHasWork(confirming: ConfirmingState): boolean {
  return Boolean(confirming.dirty) || confirming.actions.some((a) => a.saved);
}

async function handleSubmit(current: ReadyView, opts?: { replace?: boolean }) {
  if (current.busy || (!inputText.trim() && !current.pendingFile)) return;
  if (current.confirming && !opts?.replace && reviewHasWork(current.confirming)) {
    pendingFocus = "#replace-keep";
    setState({ ...current, replacePrompt: true });
    announce("Sending this replaces the review below, including your changes. Replace it, or keep reviewing.", true);
    return;
  }
  const base: ReadyView = { ...current, replacePrompt: undefined };
  // Captured before the parse — a file submission has no text to show back,
  // and inputText itself gets cleared once the review screen renders.
  const submittedText = base.pendingFile ? undefined : inputText.trim();
  const busyKind = base.pendingFile ? "file" : "text";
  const busyLabel = base.pendingFile ? "Reading the file…" : "Reading your message…";
  const controller = new AbortController();
  activeParse = controller;
  setState({ ...base, busy: true, busyLabel, busyKind });
  announce(busyLabel);
  try {
    const result = base.pendingFile
      ? await parseFile(base.pendingFile, controller.signal)
      : await parseText(inputText.trim(), controller.signal);
    if (controller.signal.aborted) return;
    await handleParsed(base, result, submittedText);
  } catch (err) {
    if (controller.signal.aborted) return;
    handleApiErrorOrElse(base, err, "Couldn't read that. Try again.");
  } finally {
    if (activeParse === controller) activeParse = null;
  }
}

async function handleDetectPage(current: ReadyView) {
  const base: ReadyView = { ...current, replacePrompt: undefined };
  const controller = new AbortController();
  activeParse = controller;
  setState({ ...base, busy: true, busyLabel: "Looking for events on this page…", busyKind: "page", notice: undefined });
  announce("Looking for events on this page…");
  try {
    let pageText = await scanPageText();
    if (!pageText) {
      // Empty could mean a genuinely blank page, or it could mean
      // activeTab no longer covers this tab (see ensureActiveTabAccess) —
      // ask for standing access and retry once before giving up.
      const granted = await ensureActiveTabAccess();
      if (controller.signal.aborted) return;
      if (!granted) {
        const notice = "kinroo needs permission to read this page. Allow it when Chrome asks, then scan again.";
        setState({ ...base, busy: false, busyLabel: undefined, busyKind: undefined, notice, noticeError: true });
        announce(notice, true);
        return;
      }
      pageText = await scanPageText();
    }
    if (controller.signal.aborted) return;
    if (!pageText) {
      const notice = "This page has no text kinroo can read. Try a screenshot instead.";
      setState({ ...base, busy: false, busyLabel: undefined, busyKind: undefined, notice, noticeError: true });
      announce(notice, true);
      return;
    }
    const result = await parseText(pageText, controller.signal);
    if (controller.signal.aborted) return;
    await handleParsed(base, result);
  } catch (err) {
    if (controller.signal.aborted) return;
    handleApiErrorOrElse(base, err, "Couldn't scan this page. Try again.");
  } finally {
    if (activeParse === controller) activeParse = null;
  }
}

// Abandons the running parse. The typed text (or attached file) is still
// there, so this is "stop", not "discard".
function cancelParse(current: ReadyView): void {
  activeParse?.abort();
  activeParse = null;
  pendingFocus = "#text-input";
  setState({ ...current, busy: false, busyLabel: undefined, busyKind: undefined });
  announce("Stopped. Nothing was sent to your calendar.");
}

function conflictKey(item: EditableAction | undefined): string {
  return (item?.conflicts ?? []).map((c) => c.id).join(",");
}

// Fires after a start/end edit; the row's conflict line was already
// cleared in place, this fills it back in once the check comes back.
// Patched into the DOM rather than re-rendered, for the same reason as
// commitState — the user is very likely still in the time fields. Only a
// real change is announced: a new overlap, or one that went away.
function recheckConflicts(actions: EditableAction[], index: number, before: string): void {
  annotateConflicts(actions).then((annotated) => {
    if (state.kind !== "ready" || !state.confirming) return;
    const live = state.confirming.actions;
    const merged = live.map((item, i) => ({ ...item, conflicts: annotated[i]?.conflicts }));
    commitState({ ...state, confirming: { ...state.confirming, actions: merged } });
    merged.forEach((item, i) => {
      const slot = document.querySelector(`.conflict-slot[data-index="${i}"]`);
      if (slot) slot.innerHTML = renderConflict(item);
    });
    const row = merged[index];
    const after = conflictKey(row);
    if (!row || after === before) return;
    if (row.conflicts?.length) announce(`Now overlaps ${row.conflicts[0].title}.`);
    else if (before) announce("No longer overlaps anything on your calendar.");
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
// recurrence, guests, etc. are gone), which the Undo result says out loud
// (see handleUndo); Google's own Calendar trash still covers a truly
// precise recovery.
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

const VERB: Record<EventAction["type"], { label: string; past: string; busy: string }> = {
  create: { label: "Add", past: "Added", busy: "Adding…" },
  update: { label: "Update", past: "Updated", busy: "Updating…" },
  delete: { label: "Cancel", past: "Canceled", busy: "Canceling…" },
};

// The review's wording is driven by every row, not just the first — a
// mixed list ("add these two, cancel that one") gets neutral "changes"
// language instead of borrowing the first row's verb for all of them.
function reviewKind(actions: EditableAction[]): EventAction["type"] | "mixed" {
  const types = new Set(actions.map((a) => a.action.type));
  return types.size === 1 ? [...types][0] : "mixed";
}

function actionTitle(action: EventAction): string {
  return action.type === "delete" ? action.original.title : action.candidate.title;
}

// "Added “Dentist” on Sunday, September 27." / "Added 3 events." — says
// what landed and where to see it, instead of "Added 1 event(s)."
function buildSavedNotice(saved: EditableAction[], total: number): { text: string; link?: { href: string; label: string } } {
  const kind = reviewKind(saved);
  const partial = saved.length < total ? ` (${saved.length} of ${total})` : "";
  let text: string;
  if (saved.length === 1) {
    const { action } = saved[0];
    const title = `“${actionTitle(action)}”`;
    text =
      action.type === "create"
        ? `Added ${title} on ${formatHumanDate(action.candidate.start)}.`
        : `${VERB[action.type].past} ${title}.`;
  } else {
    text = kind === "mixed" ? `Saved ${plural(saved.length, "change")}${partial}.` : `${VERB[kind].past} ${plural(saved.length, "event")}${partial}.`;
  }
  const firstWithDate = saved.find((s) => s.action.type !== "delete");
  const link =
    firstWithDate && firstWithDate.action.type !== "delete"
      ? { href: calendarDayUrl(firstWithDate.action.candidate.start), label: "View in Calendar" }
      : undefined;
  return { text, link };
}

async function handleConfirm(current: ReadyView) {
  const confirming = current.confirming;
  if (!confirming || current.busy) return;
  // Rows that already went through on an earlier attempt are never sent
  // again — retrying the whole list after a partial failure used to write a
  // second copy of every row that had succeeded.
  const pending = confirming.actions
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.selected && !item.saved);
  if (pending.length === 0 || pending.some(({ item }) => !isActionComplete(item.action))) return;
  const kind = reviewKind(pending.map((p) => p.item));
  setState({ ...current, busy: true, confirming: { ...confirming, error: undefined } });
  announce(kind === "mixed" ? "Saving…" : VERB[kind].busy);
  try {
    const result = await applyActions(pending.map((p) => p.item.action));
    const undoNow = buildUndoActions(
      pending.map((p) => p.item),
      result.events,
    );
    const actions = confirming.actions.slice();
    const savedIds = [...(confirming.savedIds ?? [])];
    let failures = 0;
    pending.forEach((p, k) => {
      const outcome = result.events[k];
      if (outcome?.ok) {
        actions[p.index] = { ...actions[p.index], saved: true, saveError: undefined };
        if (outcome.event?.id) savedIds.push(outcome.event.id);
      } else {
        failures += 1;
        actions[p.index] = { ...actions[p.index], saveError: friendlyRowError(outcome && !outcome.ok ? outcome.error : "") };
      }
    });
    const savedUndo = [...(confirming.savedUndo ?? []), ...undoNow];

    if (failures > 0) {
      const landed = pending.length - failures;
      const error =
        landed > 0
          ? `${failures} of ${pending.length} didn't save. The rest ${landed === 1 ? "is" : "are"} on your calendar, and Retry only sends the ${failures === 1 ? "one" : "ones"} marked “Didn't save”.`
          : pending.length === 1
            ? "That didn't save. Nothing changed on your calendar — try again."
            : "None of these saved. Nothing changed on your calendar — try again.";
      pendingFocus = "#confirm";
      setState({ ...current, busy: false, confirming: { ...confirming, actions, savedUndo, savedIds, error } });
      announce(error, true);
      return;
    }

    const saved = actions.filter((a) => a.saved);
    const { text, link } = buildSavedNotice(saved, saved.length);
    pendingFocus = "#text-input";
    enterReady(current.email, {
      notice: text,
      noticeLink: link,
      undo: savedUndo.length > 0 ? savedUndo : undefined,
      highlightIds: savedIds,
    });
    announce(text);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      expireSession();
      return;
    }
    const error = friendlyError(err, "Couldn't save. Try again.");
    pendingFocus = "#confirm";
    setState({ ...current, busy: false, confirming: { ...confirming, error } });
    announce(error, true);
  }
}

// Backing out of a review. If part of it already saved (a partial failure
// the user chose not to retry), that part is real and gets the same notice
// and Undo a full success would.
function dismissConfirm(current: ReadyView): void {
  const confirming = current.confirming;
  if (!confirming) return;
  const saved = confirming.actions.filter((a) => a.saved);
  pendingFocus = "#text-input";
  if (saved.length > 0) {
    const { text, link } = buildSavedNotice(saved, confirming.actions.length);
    enterReady(current.email, {
      notice: text,
      noticeLink: link,
      undo: confirming.savedUndo?.length ? confirming.savedUndo : undefined,
      highlightIds: confirming.savedIds,
    });
    announce(text);
    return;
  }
  setState({ ...current, confirming: undefined });
  announce("Review discarded. Nothing changed.");
}

function closeAnswer(current: ReadyView): void {
  pendingFocus = "#text-input";
  setState({ ...current, answer: undefined, answerEvents: undefined, answerQuery: undefined });
}

let noticeTimer: number | undefined;

async function handleUndo(current: ReadyView) {
  if (!current.undo?.length || current.busy) return;
  const restoresDeleted = current.undo.some((a) => a.type === "create");
  setState({ ...current, busy: true, busyLabel: "Undoing…" });
  announce("Undoing…");
  try {
    await applyActions(current.undo);
    const notice = restoresDeleted
      ? "Restored as a new event. Repeats and guests from the original don't carry over."
      : "Undone. Your calendar is back how it was.";
    pendingFocus = "#text-input";
    enterReady(current.email, { notice });
    announce(notice);
    // A plain confirmation with nothing left to act on doesn't need to
    // stay until dismissed — unlike an Undo-able notice, which does.
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      if (state.kind === "ready" && state.notice === notice) {
        setState({ ...state, notice: undefined });
      }
    }, restoresDeleted ? 12000 : 6000);
  } catch (err) {
    handleApiErrorOrElse(current, err, "Couldn't undo. Try again.");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderUnauthenticated(view: Extract<View, { kind: "unauthenticated" }>): string {
  return `
    <section class="welcome" aria-labelledby="welcome-title">
      <h2 id="welcome-title" class="welcome-title">Your calendar, in plain English.</h2>
      <ul class="welcome-points">
        <li>${ICON_CHECK}<span>Type it, paste it, or drop in a screenshot — kinroo finds the events.</span></li>
        <li>${ICON_CHECK}<span>Nothing is added, moved, or canceled until you review and confirm it.</span></li>
        <li>${ICON_CHECK}<span>Access covers your Google Calendar only — not Gmail or Drive.</span></li>
      </ul>
      ${view.error ? `<p class="notice error" role="alert">${escapeHtml(view.error)}</p>` : ""}
      <button id="connect" class="primary block">Connect Google Calendar</button>
    </section>
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

// Ticks at module scope (like the tab-selection listeners above) rather
// than being started/stopped per render — cheap to no-op via the
// getElementById check when the hint isn't currently showing (user typing,
// or on a different screen entirely), and avoids interval lifecycle
// bookkeeping tied to render() calls. Skipped entirely under reduced
// motion: the first example just stays put.
function tickExampleRotation(): void {
  if (reducedMotion.matches || document.hidden) return;
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
function renderEventTiles(events: CalendarEvent[], highlightIds: string[] = []): string {
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
        <div class="upcoming-group" role="group" aria-label="${escapeAttr(group.heading)}">
          <p class="upcoming-group-heading" aria-hidden="true">${escapeHtml(group.heading)}</p>
          <ul class="upcoming-list">
          ${group.events
            .map((event) => {
              const isNew = highlightIds.includes(event.id);
              return `
            <li class="upcoming-row${isNew ? " is-new" : ""}" title="${escapeAttr(event.title)} — ${escapeAttr(formatEventTime(event.start, event.end))}${event.location ? ` · ${escapeAttr(event.location)}` : ""}">
              <span class="upcoming-row-time">${escapeHtml(formatTimeBadge(event))}</span>
              <span class="upcoming-row-title">${escapeHtml(event.title)}${event.location ? `<span class="upcoming-row-location"> · ${escapeHtml(event.location)}</span>` : ""}</span>
              ${isNew ? `<span class="sr-only">(just added)</span>` : ""}
            </li>`;
            })
            .join("")}
          </ul>
        </div>`,
    )
    .join("");
}

function renderUpcoming(view: ReadyView): string {
  const events = view.upcomingEvents ?? [];
  const shown = events.slice(0, UPCOMING_LIMIT);
  const more = events.length - shown.length;
  const body = view.upcomingLoading
    ? `<p class="upcoming-empty" role="status">Loading your next two weeks…</p>`
    : !events.length
      ? `<p class="upcoming-empty">Nothing on your calendar for the next two weeks.</p>`
      : renderEventTiles(shown, view.highlightIds);
  return `
    <section class="below-compose upcoming" aria-labelledby="upcoming-heading">
      <h2 id="upcoming-heading" class="section-heading">Upcoming</h2>
      ${body}
      ${
        more > 0
          ? `<a class="more-link" href="https://calendar.google.com/calendar/r/agenda" target="_blank" rel="noopener">${plural(more, "more event")} in the next two weeks</a>`
          : ""
      }
    </section>
  `;
}

// Rendered into the static #header-actions slot in panel.html (empty for
// every other view) — an icon cluster instead of raw email/calendar text,
// which used to cost ~30px of vertical space on every single screen.
// "Open Google Calendar" lives here (rather than under the upcoming-events
// list, where it used to be) so it stays reachable no matter which of the
// three below-compose slots — upcoming, confirm, or answer — is showing.
// The account menu is a disclosure (button + panel), not an ARIA menu: it
// holds read-only details alongside its one action.
function renderHeaderActions(view: ReadyView): string {
  const initial = view.email.trim().charAt(0).toUpperCase() || "?";
  return `
    <a id="open-calendar" class="icon-btn" href="https://calendar.google.com/calendar/r" target="_blank" rel="noopener" title="Open Google Calendar" aria-label="Open Google Calendar">${ICON_CALENDAR}</a>
    <button id="settings-icon" class="icon-btn" title="Settings" aria-label="Settings (opens in a new tab)">${ICON_SETTINGS}</button>
    <div id="avatar-wrapper" class="avatar-wrapper">
      <button id="avatar-btn" class="avatar-btn" title="${escapeAttr(view.email)}" aria-label="Account: ${escapeAttr(view.email)}" aria-expanded="${avatarMenuOpen}" aria-controls="avatar-menu">
        ${
          view.pictureUrl
            ? `<img id="avatar-img" class="avatar-img" src="${escapeAttr(view.pictureUrl)}" alt="" referrerpolicy="no-referrer" />`
            : ""
        }
        <span class="avatar-initial" aria-hidden="true">${escapeHtml(initial)}</span>
      </button>
      ${
        avatarMenuOpen
          ? `<div id="avatar-menu" class="avatar-menu" tabindex="-1" aria-label="Account">
               <p class="avatar-menu-email">${escapeHtml(view.email)}</p>
               ${view.calendarLabel ? `<p class="avatar-menu-calendar">New events go to ${escapeHtml(view.calendarLabel)}</p>` : ""}
               <button id="signout" class="avatar-menu-item">Sign out</button>
             </div>`
          : ""
      }
    </div>
  `;
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_KEYS = IS_MAC ? "⌘Z" : "Ctrl+Z";

// The message gets its own full-width line; its actions sit on a row
// beneath it, so a narrow panel never squeezes the text into a one-word
// column beside them.
function renderNotice(view: ReadyView): string {
  if (!view.notice) return "";
  const icon = view.noticeError ? ICON_ALERT : ICON_CHECK;
  const actions = [
    view.noticeLink
      ? `<a class="notice-action" href="${escapeAttr(view.noticeLink.href)}" target="_blank" rel="noopener">${escapeHtml(view.noticeLink.label)}</a>`
      : "",
    view.undo?.length
      ? `<button id="undo" class="notice-action" title="Undo (${UNDO_KEYS})" aria-keyshortcuts="${IS_MAC ? "Meta+Z" : "Control+Z"}" ${view.busy ? "disabled" : ""}>Undo</button>`
      : "",
  ].join("");
  return `
    <div class="notice-row">
      <div class="notice${view.noticeError ? " error" : " success"}">
        <span class="notice-icon">${icon}</span>
        <div class="notice-main">
          <p class="notice-text">${escapeHtml(view.notice)}</p>
          ${actions ? `<div class="notice-actions">${actions}</div>` : ""}
        </div>
        <button id="notice-dismiss" class="notice-close" aria-label="Dismiss message" title="Dismiss">${ICON_CLEAR}</button>
      </div>
    </div>`;
}

let busyStartedAt = 0;
const BUSY_SLOW_MS = 6000;

const SLOW_HINT: Record<NonNullable<ReadyView["busyKind"]>, string> = {
  text: "Still working — longer messages take a few extra seconds.",
  file: "Still reading — screenshots and PDFs can take up to 20 seconds.",
  page: "Still reading — long pages can take up to 20 seconds.",
};

// The label itself is already announced when work starts (so it's hidden
// here to avoid a double read); the slow hint is announced when it
// appears, and Cancel is a real, reachable control.
function renderBusy(view: ReadyView): string {
  if (!view.busy || !view.busyLabel) return "";
  return `
    <div class="busy-row">
      <span class="busy-label" aria-hidden="true">${SPINNER}<span>${escapeHtml(view.busyLabel)}</span></span>
      ${view.busyKind ? `<button id="busy-cancel" class="text-btn">Cancel</button>` : ""}
      ${view.busyKind ? `<span id="busy-slow" class="busy-slow" hidden>${escapeHtml(SLOW_HINT[view.busyKind])}</span>` : ""}
    </div>`;
}

// Shown in place of sending when an edited review would be thrown away.
// Focus lands on "Keep reviewing", so a reflexive second Enter is the safe
// choice.
function renderReplacePrompt(view: ReadyView): string {
  if (!view.replacePrompt || !view.confirming) return "";
  const saved = view.confirming.actions.filter((a) => a.saved).length;
  return `
    <div class="replace-prompt" role="group" aria-labelledby="replace-text">
      <p id="replace-text">Sending this replaces the review below and drops your changes to it.${saved ? ` The ${plural(saved, "event")} already saved stay on your calendar.` : ""}</p>
      <div class="replace-actions">
        <button id="replace-keep" class="btn-secondary">Keep reviewing</button>
        <button id="replace-go" class="btn-secondary is-danger">Replace review</button>
      </div>
    </div>`;
}

function renderReady(view: ReadyView): string {
  const fileChip = view.pendingFile
    ? `<div class="file-chip">
         ${view.pendingFile.type.startsWith("image/") ? `<img id="file-thumb" class="file-thumb" alt="" />` : ""}
         <span class="file-name">${escapeHtml(view.pendingFile.name)}</span>
         <button id="remove-file" class="text-btn" aria-label="Remove ${escapeAttr(view.pendingFile.name)}">Remove</button>
       </div>`
    : "";

  // The hint teaches the product without competing for attention: it's only
  // useful before you've typed anything and before a confirm/answer is
  // already occupying the slot below — once either is true it'd just be
  // idle chrome sitting above real content.
  const hasFollowup = Boolean(view.confirming) || view.answer !== undefined;
  const showHint = !inputText.trim() && !hasFollowup;
  // While a review or answer is up, it's the main thing on screen — compose
  // drops to a single line so the decision isn't pushed below an empty box.
  const compact = hasFollowup && !inputText.includes("\n") && !view.pendingFile;

  // Confirm and answer take over the same slot upcoming events normally
  // occupy — only one of the three shows at a time, right below compose,
  // instead of replacing the whole panel the way separate views used to.
  const followup = view.confirming
    ? `<section class="below-compose confirm-block" aria-labelledby="review-heading">${renderConfirming(view.confirming, view.busy, view.calendarLabel)}</section>`
    : view.answer !== undefined
      ? `<section class="below-compose answer-block" aria-label="Answer">${renderAnswer(view.answer, view.answerEvents, view.answerQuery, view.answerLead)}</section>`
      : renderUpcoming(view);

  const sendLabel = view.busy ? "Working" : "Send";

  return `
    <div id="compose" class="compose${compact ? " is-compact" : ""}" ${view.busy ? 'aria-busy="true"' : ""}>
      <div class="compose-input-wrap">
        <textarea id="text-input" rows="${compact ? 1 : 2}" placeholder="${compact ? "Add or ask something else" : ""}" aria-label="Add an event or ask about your calendar" aria-describedby="compose-help" ${view.busy ? 'readonly aria-busy="true"' : ""}>${escapeHtml(inputText)}</textarea>
        <div id="compose-hint" class="compose-hint" aria-hidden="true" style="${showHint ? "" : "display:none;"}">
          <span class="compose-hint-title">Add an event, or ask about your calendar</span>
          <span id="compose-hint-example" class="compose-hint-example">${escapeHtml(EXAMPLE_PROMPTS[exampleIndex])}</span>
        </div>
        <p id="compose-help" class="sr-only">For example: ${escapeHtml(EXAMPLE_PROMPTS.join("; "))}. Enter sends; Shift+Enter starts a new line.</p>
      </div>
      ${fileChip}
      <div class="compose-toolbar">
        <div class="compose-toolbar-left">
          <button id="attach-btn" type="button" class="icon-btn" title="Attach a screenshot, photo, or PDF" aria-label="Attach a screenshot, photo, or PDF" ${view.busy ? "disabled" : ""}>${ICON_ATTACH}</button>
          <input id="file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" hidden ${view.busy ? "disabled" : ""} />
          <button id="scan-btn" type="button" class="icon-btn" title="Find events on this page" aria-label="Find events on this page" ${view.busy ? "disabled" : ""}>${ICON_PAGE}</button>
          <button id="clear-btn" type="button" class="icon-btn" title="Clear text" aria-label="Clear text" ${view.busy ? "disabled" : ""} style="${inputText.trim() ? "" : "display:none;"}">${ICON_BACKSPACE}</button>
        </div>
        <button id="submit" type="button" class="send-btn" title="Send (Enter)" aria-label="${sendLabel}" ${view.busy || (!inputText.trim() && !view.pendingFile) ? "disabled" : ""}>${view.busy ? SPINNER : ICON_SEND}</button>
      </div>
    </div>
    ${renderReplacePrompt(view)}
    ${renderBusy(view)}
    ${renderNotice(view)}
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

// Turns an iCalendar date or UTC basic-format datetime ("20261215",
// "20261126T180000Z") into a short local-date label ("Nov 26", or
// "Dec 15, 2027" outside the current year).
function formatIcalDate(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value);
  if (!match) return value;
  const [, y, mo, d, h, mi, s] = match;
  const date = h
    ? new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
    : new Date(Number(y), Number(mo) - 1, Number(d));
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

// Turns the recurrence lines (RFC 5545) into a short human-readable summary
// for the confirm list — not a full renderer, just enough for the common
// cases the extraction schema actually produces (an RRULE with
// FREQ/INTERVAL/BYDAY/COUNT/UNTIL, plus an optional EXDATE line).
function formatRecurrence(lines: string[]): string {
  const rule = lines.find((line) => line.startsWith("RRULE")) ?? lines[0];
  const parts = Object.fromEntries(
    rule
      .replace(/^RRULE:/, "")
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );

  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const freqWord = RECURRENCE_FREQ_LABEL[parts.FREQ] ?? parts.FREQ?.toLowerCase() ?? "time";
  let label = `Repeats every ${interval > 1 ? `${interval} ` : ""}${freqWord}${interval > 1 ? "s" : ""}`;

  if (parts.BYDAY) {
    label += ` on ${parts.BYDAY.split(",")
      .map((day) => RECURRENCE_DAY_LABEL[day] ?? day)
      .join(", ")}`;
  }
  if (parts.COUNT) label += `, ${parts.COUNT} times`;
  else if (parts.UNTIL) label += ` until ${formatIcalDate(parts.UNTIL)}`;

  const exdateLine = lines.find((line) => line.startsWith("EXDATE"));
  if (exdateLine) {
    const dates = exdateLine
      .replace(/^EXDATE(;[^:]*)?:/, "")
      .split(",")
      .map(formatIcalDate);
    label += `, except ${dates.join(", ")}`;
  }
  return label;
}

function renderConflict(item: EditableAction): string {
  if (item.action.type !== "create" || !item.conflicts?.length) return "";
  const first = item.conflicts[0];
  const when = isAllDay(first) ? "all day" : formatHumanTimeRange(first.start, first.end);
  const more = item.conflicts.length > 1 ? `, plus ${plural(item.conflicts.length - 1, "other")}` : "";
  return `
    <p class="conflict-warning">
      ${ICON_ALERT}
      <span>Overlaps <strong>${escapeHtml(first.title)}</strong> <span class="nowrap">(${escapeHtml(when)})</span>${escapeHtml(more)}</span>
    </p>`;
}

// For an update, each changed field carries a quiet "was …" line right
// under it, so the change is readable at a glance instead of by comparing
// a "Currently:" line against the whole card.
function wasLine(text: string): string {
  return `<p class="was-line"><span class="sr-only">Previously: </span><span aria-hidden="true">was </span>${escapeHtml(text)}</p>`;
}

// The row whose time editor should render already open — set only across
// the one render an all-day toggle causes, so the editor (and the toggle
// that has focus) doesn't snap shut under the user.
let openTimeEditor: number | null = null;

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// A rule like "every Tue, Thu" whose first date is a Saturday still adds
// that Saturday (Google counts the start as the first occurrence) — worth
// saying before it quietly lands on the wrong day.
function recurrenceStartWarning(start: string, recurrence: string[]): string {
  const byDay = /BYDAY=([^;]+)/.exec(recurrence.find((line) => line.startsWith("RRULE")) ?? "")?.[1];
  if (!byDay) return "";
  const days = byDay.split(",").map((d) => d.replace(/^[+-]?\d+/, ""));
  const date = parseEventDate(start);
  if (days.includes(WEEKDAY_CODES[date.getDay()])) return "";
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  return `<p class="conflict-warning">${ICON_ALERT}<span>The first date is a ${escapeHtml(weekday)}, which isn't one of the repeat days. Google Calendar will still add it.</span></p>`;
}

// The clickable time line on a review tile — or a prompt to add one when
// the parse found no date. Shared by the full render and syncTimeSummary.
function timeSummaryInner(c: EventCandidate): string {
  const body = hasTimes(c)
    ? `<span class="candidate-time-date">${escapeHtml(formatHumanDate(c.start))}</span>
        <span class="candidate-time-range">${escapeHtml(formatHumanTimeRange(c.start, c.end))}</span>`
    : `<span class="candidate-time-date">Add date and time</span>`;
  return `${body}<span class="edit-cue">${ICON_EDIT}</span>`;
}

function timeSummaryLabel(c: EventCandidate): string {
  return hasTimes(c)
    ? `Date and time: ${formatHumanDate(c.start)}, ${formatHumanTimeRange(c.start, c.end)}. Edit`
    : "Date and time missing. Add date and time";
}

function renderEditableFields(
  action: Extract<EventAction, { type: "create" | "update" }>,
  i: number,
  locked: boolean,
): string {
  const c = action.candidate;
  const o = action.type === "update" ? action.original : undefined;
  const allDay = isDateOnly(c.start);
  const titleChanged = Boolean(o && o.title !== c.title);
  const timed = hasTimes(c);
  const titleMissing = !c.title.trim();
  const timeChanged = Boolean(
    timed && o && (parseEventDate(o.start).getTime() !== parseEventDate(c.start).getTime() || parseEventDate(o.end).getTime() !== parseEventDate(c.end).getTime()),
  );
  // An update's candidate leaves location out when it isn't changing (the
  // PATCH then leaves Google's value alone), so show the current one
  // rather than an empty "Add location" that looks like it was removed.
  const location = c.location ?? o?.location ?? "";
  const locationChanged = Boolean(o && c.location !== undefined && (o.location ?? "") !== c.location);
  const recurrenceNote =
    action.type === "create" && c.recurrence?.length
      ? `<p class="meta-note">${ICON_REPEAT}<span>${escapeHtml(formatRecurrence(c.recurrence))}</span></p>${timed ? recurrenceStartWarning(c.start, c.recurrence) : ""}`
      : "";
  // Everything displays in the browser's local time; only worth saying so
  // when the event itself was pinned to a different zone.
  const tzNote =
    !allDay && c.timezone && c.timezone !== LOCAL_TIMEZONE
      ? `<p class="meta-note">${ICON_GLOBE}<span>Shown in your time zone · event is set in ${escapeHtml(c.timezone.replace(/_/g, " "))}</span></p>`
      : "";
  const lockAttr = locked ? "disabled" : "";
  const changed = (flag: boolean) => (flag ? " is-changed" : "");
  // All-day events edit as dates, not datetimes — a datetime-local input
  // would turn "Sunday, all day" into a midnight-to-midnight timed event
  // the moment anything was touched. The end shown is the last day, not
  // Google's exclusive end.
  const timeInputs = allDay
    ? `<label class="time-field"><span>Starts</span><input type="date" class="cand-start" data-index="${i}" value="${c.start}" ${lockAttr} /></label>
        <label class="time-field"><span>Ends</span><input type="date" class="cand-end" data-index="${i}" value="${toDateValue(lastAllDay(c.end))}" min="${c.start}" ${lockAttr} /></label>`
    : `<label class="time-field"><span>Starts</span><input type="datetime-local" class="cand-start" data-index="${i}" value="${toDatetimeLocalValue(c.start)}" ${lockAttr} /></label>
        <label class="time-field"><span>Ends</span><input type="datetime-local" class="cand-end" data-index="${i}" value="${toDatetimeLocalValue(c.end)}" ${lockAttr} /></label>`;
  return `
    <textarea class="cand-title${changed(titleChanged)}${titleMissing ? " missing" : ""}" data-index="${i}" rows="1" placeholder="Add a title" aria-label="Event title" ${titleMissing ? 'aria-invalid="true"' : ""} spellcheck="false" ${lockAttr}>${escapeHtml(c.title)}</textarea>
    ${titleChanged && o ? wasLine(`“${o.title}”`) : ""}
    <div class="candidate-time-edit${openTimeEditor === i ? " editing" : ""}" data-index="${i}">
      <button type="button" class="candidate-time-summary${changed(timeChanged)}${timed ? "" : " missing"}" data-index="${i}" aria-label="${escapeAttr(timeSummaryLabel(c))}" ${lockAttr}>
        ${timeSummaryInner(c)}
      </button>
      <div class="candidate-times">
        ${timeInputs}
        <label class="allday-toggle"><input type="checkbox" class="cand-allday" data-index="${i}" ${allDay ? "checked" : ""} ${lockAttr} /><span>All day</span></label>
      </div>
    </div>
    ${timeChanged && o ? wasLine(formatEventTime(o.start, o.end)) : ""}
    <input type="text" class="cand-location${changed(locationChanged)}" data-index="${i}" value="${escapeAttr(location)}" placeholder="+ Add location" aria-label="Location" ${lockAttr} />
    ${locationChanged && o ? wasLine(o.location ? o.location : "no location") : ""}
    ${recurrenceNote}
    ${tzNote}
  `;
}

// A pending change reads as a draft: a dashed outline means "not on your
// calendar yet", and it turns solid with a check once it has actually
// saved (only ever visible after a partial failure, when some rows landed
// and others didn't). A cancel reads differently in the hand from an add —
// danger-tinted outline, struck-through title — so a mismatched "cancel my
// dentist" can't be confirmed on autopilot. A single proposed event skips
// the checkbox (there's nothing to select between); two or more keep it so
// the user can choose which ones to act on.
function renderCandidateTile(item: EditableAction, i: number, isSingle: boolean, busy: boolean): string {
  const { action } = item;
  const title = actionTitle(action);
  const locked = Boolean(item.saved) || busy;
  const classes = [
    "candidate-tile",
    action.type === "delete" ? "is-delete" : "",
    item.saved ? "is-saved" : "",
    !isSingle && !item.selected && !item.saved ? "is-excluded" : "",
    item.saveError && !item.saved ? "has-error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body =
    action.type === "delete"
      ? `<p class="delete-title">${escapeHtml(action.original.title)}</p>
         <p class="delete-when">${escapeHtml(formatEventTime(action.original.start, action.original.end))}</p>`
      : renderEditableFields(action, i, locked);

  const lead = item.saved
    ? `<span class="saved-mark" title="Saved">${ICON_CHECK}<span class="sr-only">Saved</span></span>`
    : isSingle
      ? ""
      : `<input type="checkbox" class="cand-selected" data-index="${i}" ${item.selected ? "checked" : ""} ${busy ? "disabled" : ""} aria-label="Include ${escapeAttr(title)}" />`;

  return `
    <li class="${classes}" data-index="${i}">
      ${lead}
      <div class="candidate-body">
        ${body}
        <div class="conflict-slot" data-index="${i}" aria-live="off">${item.saved ? "" : renderConflict(item)}</div>
        ${item.saveError && !item.saved ? `<p class="row-error">${ICON_ALERT}<span><strong>Didn't save.</strong> ${escapeHtml(item.saveError)}</span></p>` : ""}
      </div>
    </li>`;
}

// The review's own wording, derived from what's still left to do. Kept in
// one place so the in-place checkbox/select-all updates and a full render
// can never disagree.
function reviewCopy(confirming: ConfirmingState, calendarLabel: string | undefined) {
  const remaining = confirming.actions.filter((a) => !a.saved);
  const savedCount = confirming.actions.length - remaining.length;
  const kind = reviewKind(remaining.length ? remaining : confirming.actions);
  const pending = remaining.filter((a) => a.selected || confirming.actions.length === 1);
  const n = pending.length;
  // A parse can leave a title or time blank when the source never said;
  // nothing is written until every selected row is filled in.
  const incomplete = pending.some((a) => !isActionComplete(a.action));
  const anySaved = savedCount > 0;
  const many = confirming.actions.length > 1;
  const noun = kind === "mixed" ? "change" : "event";
  const where = calendarLabel ? escapeHtml(calendarLabel) : "your calendar";
  const first = confirming.actions[0]?.action;
  const repeating = !many && first?.type === "create" && Boolean(first.candidate.recurrence?.length);

  // After a partial save the question is no longer "add these?" — some of
  // them are already there — so the header says what actually happened.
  const heading = anySaved
    ? `${plural(remaining.length, noun)} didn't save`
    : kind === "mixed"
      ? "Save these changes?"
      : `${kind === "create" ? "Add" : kind === "update" ? "Update" : "Cancel"} ${many ? `these ${confirming.actions.length} events` : repeating ? "this repeating event" : "this event"}?`;

  const sub = anySaved
    ? `${plural(savedCount, noun)} ${savedCount === 1 ? "is" : "are"} already on <strong>${where}</strong>. Retry the rest, or choose Done to keep only what saved.`
    : kind === "delete"
      ? `Stays on <strong>${where}</strong> until you confirm.`
      : kind === "update"
        ? `Changes <strong>${where}</strong> only when you confirm. Click any detail to edit it.`
        : kind === "create"
          ? `Goes to <strong>${where}</strong> only when you confirm. Click any detail to edit it.`
          : `Nothing changes on <strong>${where}</strong> until you confirm.`;

  const verb = kind === "mixed" ? "Save" : VERB[kind].label;
  const confirmLabel = anySaved
    ? `Retry ${plural(n, noun)}`
    : many
      ? n === 0
        ? `Select ${noun}s to ${verb.toLowerCase()}`
        : `${verb} ${plural(n, noun)}`
      : repeating
        ? "Add repeating event"
        : `${verb} event`;
  const busyLabel = kind === "mixed" ? "Saving…" : VERB[kind].busy;
  const dismissLabel = anySaved ? "Done" : kind === "delete" ? (many ? "Keep events" : "Keep event") : "Discard";
  const summary = many && !anySaved ? `${n} of ${confirming.actions.length} selected` : "";
  const allSelected = remaining.every((a) => a.selected);
  const showSelectToggle = many && !anySaved && remaining.length > 1;

  return { heading, sub, confirmLabel, busyLabel, dismissLabel, summary, n, incomplete, danger: kind === "delete", allSelected, showSelectToggle };
}

function renderConfirming(confirming: ConfirmingState, busy: boolean | undefined, calendarLabel: string | undefined): string {
  const isSingle = confirming.actions.length === 1;
  const copy = reviewCopy(confirming, calendarLabel);
  const rows = confirming.actions.map((item, i) => renderCandidateTile(item, i, isSingle, Boolean(busy))).join("");

  return `
    ${renderSaidLine(confirming.submittedText)}
    <div class="review-head">
      <h2 id="review-heading" class="review-title" tabindex="-1">${copy.heading}</h2>
      ${
        copy.showSelectToggle
          ? `<button id="select-toggle" class="text-btn" ${busy ? "disabled" : ""}>${copy.allSelected ? "Select none" : "Select all"}</button>`
          : ""
      }
    </div>
    <p class="review-sub">${copy.sub}</p>
    <ul class="candidates" aria-labelledby="review-heading">${rows}</ul>
    ${confirming.error ? `<p class="notice error review-error">${ICON_ALERT}<span>${escapeHtml(confirming.error)}</span></p>` : ""}
    <p id="confirm-missing" class="confirm-missing" ${copy.incomplete ? "" : "hidden"}>${ICON_ALERT}<span>Fill in the details marked in red — a title and a date — to continue.</span></p>
    <div class="confirm-footer">
      <button id="confirm-dismiss" class="btn-secondary" ${busy ? "disabled" : ""}>${copy.dismissLabel}</button>
      <span id="selection-summary" class="selection-summary" aria-live="polite">${copy.summary}</span>
      <button id="confirm" class="primary${copy.danger ? " danger" : ""}" ${busy || copy.n === 0 || copy.incomplete ? "disabled" : ""} aria-describedby="confirm-missing" aria-keyshortcuts="Control+Enter Meta+Enter">
        ${busy ? `${SPINNER}<span>${copy.busyLabel}</span>` : escapeHtml(copy.confirmLabel)}
      </button>
    </div>
  `;
}

// Quiet reminder of what was actually typed/scanned, since the compose box
// clears itself as soon as a review screen (confirm or answer) takes over
// the slot below it — without this the context you just typed is gone the
// moment you can no longer act on it. Omitted for submissions with nothing
// meaningful to quote back (a file attachment, a page scan). Long text
// (a pasted email) clamps to two lines and expands on click.
const SAID_EXPANDABLE_CHARS = 90;

function renderSaidLine(submittedText: string | undefined): string {
  if (!submittedText) return "";
  const quoted = `“${escapeHtml(submittedText)}”`;
  if (submittedText.length <= SAID_EXPANDABLE_CHARS) {
    return `<p class="said-line"><span class="said-label">You said</span> ${quoted}</p>`;
  }
  return `<button type="button" id="said-toggle" class="said-line is-expandable" aria-expanded="false"><span class="said-label">You said</span> ${quoted}</button>`;
}

// "2 events tomorrow" / "3 events on Saturday" / "4 events" — the one
// line that tells you what the list below is before you read it.
function eventCountLead(events: CalendarEvent[]): string {
  const headings = new Set(events.map((e) => formatGroupHeading(e.start)));
  const count = plural(events.length, "event");
  if (headings.size !== 1) return count;
  const only = [...headings][0];
  return /^(Today|Tomorrow|Yesterday)$/.test(only) ? `${count} ${only.toLowerCase()}` : `${count} on ${only}`;
}

const BULLET = /^\s*[-•*]\s+/;

// Spoken form of an answer: the lead plus each event, or the text with its
// "- " bullet markers stripped so they aren't read out as "dash".
function describeAnswer(text: string, events: CalendarEvent[] | undefined, lead?: string): string {
  if (events?.length) {
    const items = events.map((e) => `${e.title}, ${formatEventTime(e.start, e.end)}`).join(". ");
    return `${lead ? `${lead} ` : ""}${eventCountLead(events)}. ${items}.`;
  }
  return text
    .split("\n")
    .map((line) => line.replace(BULLET, ""))
    .filter(Boolean)
    .join(". ");
}

// Plain-text answers keep their paragraphs, and runs of "- " lines become
// a real list.
function renderAnswerText(text: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(`<ul class="answer-list">${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const line of text.split("\n")) {
    if (BULLET.test(line)) {
      list.push(line.replace(BULLET, ""));
      continue;
    }
    flush();
    if (line.trim()) blocks.push(`<p class="answer">${escapeHtml(line)}</p>`);
  }
  flush();
  return blocks.join("");
}

// With tiles, `text` isn't shown, so a yes/no lead ("No.") goes in front of
// the count line; without them, `text` already starts with it.
function renderAnswer(
  text: string,
  events: CalendarEvent[] | undefined,
  submittedText: string | undefined,
  lead: string | undefined,
): string {
  const body = events?.length
    ? `<p class="answer-lead">${lead ? `${escapeHtml(lead)} ` : ""}${escapeHtml(eventCountLead(events))}</p>${renderEventTiles(events)}`
    : renderAnswerText(text);
  return `
    ${renderSaidLine(submittedText)}
    ${body}
    <div class="answer-footer">
      <button id="answer-dismiss" class="btn-secondary">Close</button>
    </div>
  `;
}

// Moves focus back where it was (or where a transition asked it to go)
// after innerHTML replaced everything. Elements are matched by id, or by
// class + data-index for the per-row confirm fields.
function focusKey(el: Element | null): string | null {
  if (!el || el === document.body || !root?.parentElement?.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const index = (el as HTMLElement).dataset?.index;
  const cls = el.classList[0];
  return index !== undefined && cls ? `.${CSS.escape(cls)}[data-index="${index}"]` : null;
}

let highlightTimer: number | undefined;

function render() {
  if (!root) return;

  const active = document.activeElement;
  const restoreKey = focusKey(active);
  const selection =
    active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type === "text")
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null;
  const target = pendingFocus ?? restoreKey;
  const isTransition = pendingFocus !== null;
  pendingFocus = null;

  switch (state.kind) {
    case "loading":
      root.innerHTML = `<p class="lead" role="status">Loading…</p>`;
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

  if (target) {
    let el = document.querySelector<HTMLElement>(target);
    // The focused control can vanish or disable itself across a render (a
    // send button going busy, a dismissed message) — rather than dropping
    // to <body>, land on the one place typing makes sense.
    if (!el || (el as HTMLButtonElement).disabled) el = document.querySelector<HTMLElement>("#text-input, #connect");
    if (el) {
      el.focus({ preventScroll: !isTransition });
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        if (!isTransition && selection && selection.start !== null) {
          el.setSelectionRange(selection.start, selection.end);
        } else if (el instanceof HTMLTextAreaElement) {
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }
    }
  }

  if (state.kind === "ready" && state.busy && state.busyLabel) {
    window.setTimeout(() => {
      const slow = document.getElementById("busy-slow");
      if (slow?.hidden && Date.now() - busyStartedAt >= BUSY_SLOW_MS - 50) {
        slow.hidden = false;
        announce(slow.textContent ?? "");
      }
    }, Math.max(0, BUSY_SLOW_MS - (Date.now() - busyStartedAt)));
  }

  // The just-added highlight plays once, the first time the refreshed
  // upcoming list actually contains the new event, then is dropped from
  // state so later renders don't replay it.
  if (state.kind === "ready" && state.highlightIds?.length && document.querySelector(".upcoming-row.is-new")) {
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
      if (state.kind === "ready") commitState({ ...state, highlightIds: undefined });
    }, 3200);
  }
}

function autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// Typing updates inputText without a full render() (to avoid re-rendering
// the compose box on every keystroke), so clear-btn's visibility — driven
// by inputText at render time — needs the same direct DOM toggle rather
// than waiting for the next unrelated re-render.
function syncClearBtn(): void {
  const clearBtn = document.getElementById("clear-btn");
  if (clearBtn) clearBtn.style.display = inputText.trim() ? "" : "none";
  const send = document.getElementById("submit") as HTMLButtonElement | null;
  if (send && state.kind === "ready" && !state.busy) send.disabled = !inputText.trim() && !state.pendingFile;
}

// Same reasoning as syncClearBtn. The hint only belongs on an idle compose
// box — never while a review or answer is up, even if the text is emptied.
function syncComposeHint(): void {
  const hint = document.getElementById("compose-hint");
  if (!hint || state.kind !== "ready") return;
  const hasFollowup = Boolean(state.confirming) || state.answer !== undefined;
  hint.style.display = inputText.trim() || hasFollowup ? "none" : "";
}

// Checkbox and select-all changes keep the heading, button label, and
// "n of m selected" in step without a full render.
function syncReviewControls(): void {
  if (state.kind !== "ready" || !state.confirming) return;
  const copy = reviewCopy(state.confirming, state.calendarLabel);
  const confirmBtn = document.getElementById("confirm") as HTMLButtonElement | null;
  if (confirmBtn && !state.busy) {
    confirmBtn.textContent = copy.confirmLabel;
    confirmBtn.disabled = copy.n === 0 || copy.incomplete;
  }
  const missing = document.getElementById("confirm-missing");
  if (missing) missing.hidden = !copy.incomplete;
  const summary = document.getElementById("selection-summary");
  if (summary) summary.textContent = copy.summary;
  const toggle = document.getElementById("select-toggle");
  if (toggle) toggle.textContent = copy.allSelected ? "Select none" : "Select all";
  state.confirming.actions.forEach((item, i) => {
    document
      .querySelector(`.candidate-tile[data-index="${i}"]`)
      ?.classList.toggle("is-excluded", !item.selected && !item.saved);
  });
}

// Re-draws one row's time summary after its datetime inputs change.
function syncTimeSummary(i: number, action: EventAction): void {
  if (action.type === "delete") return;
  const summary = document.querySelector(`.candidate-time-edit[data-index="${i}"] .candidate-time-summary`);
  if (summary) {
    summary.innerHTML = timeSummaryInner(action.candidate);
    summary.setAttribute("aria-label", timeSummaryLabel(action.candidate));
    summary.classList.toggle("missing", !hasTimes(action.candidate));
  }
  const slot = document.querySelector(`.conflict-slot[data-index="${i}"]`);
  if (slot) slot.innerHTML = "";
  syncReviewControls();
}

const ACCEPTED_FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

// Handlers read the live `state` at event time rather than a snapshot
// taken at render: confirm-card edits commit without re-rendering (see
// commitState), so a snapshot would confirm the pre-edit values.
function live(): ReadyView | null {
  return state.kind === "ready" ? state : null;
}

function updateAction(i: number, patch: (item: EditableAction) => EditableAction): EditableAction[] | null {
  const current = live();
  if (!current?.confirming) return null;
  const actions = current.confirming.actions.map((item, idx) => (idx === i ? patch(item) : item));
  commitState({ ...current, confirming: { ...current.confirming, actions, dirty: true } });
  return actions;
}

function attachHandlers() {
  if (state.kind === "unauthenticated") {
    document.getElementById("connect")?.addEventListener("click", handleConnect);
  }

  if (state.kind !== "ready") return;
  const current = state;

  document.getElementById("signout")?.addEventListener("click", handleSignOut);
  document.getElementById("settings-icon")?.addEventListener("click", () => {
    const s = live();
    if (s) handleOpenSettings(s);
  });
  document.getElementById("avatar-btn")?.addEventListener("click", () => {
    avatarMenuOpen = !avatarMenuOpen;
    // Opening lands on the panel itself, not on Sign out — Enter, Enter
    // must never sign someone out.
    pendingFocus = avatarMenuOpen ? "#avatar-menu" : "#avatar-btn";
    render();
  });
  // Google photo URLs are usually reliable, but fall back to the letter
  // avatar underneath rather than showing a broken-image icon.
  document.getElementById("avatar-img")?.addEventListener("error", (e) => {
    (e.target as HTMLElement).style.display = "none";
  });
  document.getElementById("submit")?.addEventListener("click", () => {
    const s = live();
    if (s) handleSubmit(s);
  });
  document.getElementById("scan-btn")?.addEventListener("click", () => {
    const s = live();
    if (s) handleDetectPage(s);
  });
  document.getElementById("undo")?.addEventListener("click", () => {
    const s = live();
    if (s) handleUndo(s);
  });
  document.getElementById("notice-dismiss")?.addEventListener("click", () => {
    const s = live();
    if (!s) return;
    pendingFocus = "#text-input";
    setState({ ...s, notice: undefined, noticeError: undefined, noticeLink: undefined });
  });
  document.getElementById("remove-file")?.addEventListener("click", () => {
    const s = live();
    if (!s) return;
    revokeThumb();
    pendingFocus = "#attach-btn";
    setState({ ...s, pendingFile: undefined });
  });
  document.getElementById("busy-cancel")?.addEventListener("click", () => {
    const s = live();
    if (s) cancelParse(s);
  });
  document.getElementById("replace-keep")?.addEventListener("click", () => {
    const s = live();
    if (!s) return;
    pendingFocus = "#review-heading";
    setState({ ...s, replacePrompt: undefined });
  });
  document.getElementById("replace-go")?.addEventListener("click", () => {
    const s = live();
    if (s) handleSubmit(s, { replace: true });
  });
  // The account panel closes once focus moves anywhere outside it (Tab,
  // Shift+Tab, clicking into compose), not just on an outside click.
  document.getElementById("avatar-wrapper")?.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    const wrapper = e.currentTarget as HTMLElement;
    if (!avatarMenuOpen || !next || wrapper.contains(next)) return;
    avatarMenuOpen = false;
    window.setTimeout(render, 0);
  });
  document.getElementById("said-toggle")?.addEventListener("click", (e) => {
    const el = e.currentTarget as HTMLElement;
    const expanded = el.getAttribute("aria-expanded") === "true";
    el.setAttribute("aria-expanded", String(!expanded));
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
    pendingFocus = "#text-input";
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
  // Enter sends, Shift+Enter starts a new line — the convention every
  // message box has taught people. Ctrl/Cmd+Enter still sends too. IME
  // composition (Japanese, Chinese input) uses Enter to commit characters,
  // so it's left alone.
  textInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    const s = live();
    if (s) handleSubmit(s);
  });
  textInput?.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        const s = live();
        if (file && s) {
          e.preventDefault();
          revokeThumb();
          pendingFocus = "#text-input";
          setState({ ...s, pendingFile: file });
        }
        return;
      }
    }
  });

  const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
  document.getElementById("attach-btn")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    const s = live();
    if (file && s) {
      revokeThumb();
      pendingFocus = "#submit";
      setState({ ...s, pendingFile: file });
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
      const s = live();
      if (!s) return;
      if (file && ACCEPTED_FILE_TYPES.includes(file.type)) {
        revokeThumb();
        pendingFocus = "#submit";
        setState({ ...s, pendingFile: file });
      } else if (file) {
        const notice = "kinroo can read screenshots, photos (PNG, JPG, GIF, WebP), and PDFs.";
        setState({ ...s, notice, noticeError: true, noticeLink: undefined });
        announce(notice, true);
      }
    });
  }

  if (current.confirming) {
    document.getElementById("confirm-dismiss")?.addEventListener("click", () => {
      const s = live();
      if (s) dismissConfirm(s);
    });
    document.getElementById("confirm")?.addEventListener("click", () => {
      const s = live();
      if (s) handleConfirm(s);
    });
    document.getElementById("select-toggle")?.addEventListener("click", () => {
      const s = live();
      if (!s?.confirming) return;
      const copy = reviewCopy(s.confirming, s.calendarLabel);
      const next = !copy.allSelected;
      const actions = s.confirming.actions.map((item) => (item.saved ? item : { ...item, selected: next }));
      commitState({ ...s, confirming: { ...s.confirming, actions, dirty: true } });
      document.querySelectorAll<HTMLInputElement>(".cand-selected").forEach((el) => {
        el.checked = next;
      });
      syncReviewControls();
    });

    document.querySelectorAll<HTMLInputElement>(".cand-selected").forEach((el) => {
      el.addEventListener("change", () => {
        updateAction(Number(el.dataset.index), (item) => ({ ...item, selected: el.checked }));
        syncReviewControls();
      });
    });

    // Presentational only — reveals the native datetime-local inputs in
    // place. They stay open while focus is anywhere inside this row's time
    // editor (so start → end is one Tab), and fold back to the summary
    // once focus leaves it.
    document.querySelectorAll<HTMLButtonElement>(".candidate-time-summary").forEach((el) => {
      el.addEventListener("click", () => {
        const wrap = el.closest(".candidate-time-edit");
        wrap?.classList.add("editing");
        wrap?.querySelector<HTMLInputElement>(".cand-start")?.focus();
      });
    });
    document.querySelectorAll<HTMLElement>(".candidate-time-edit").forEach((wrap) => {
      wrap.addEventListener("focusout", (e) => {
        const next = (e as FocusEvent).relatedTarget as Node | null;
        if (next && wrap.contains(next)) return;
        wrap.classList.remove("editing");
      });
    });

    document.querySelectorAll<HTMLTextAreaElement>(".cand-title").forEach((el) => {
      autoResizeTextarea(el);
      el.addEventListener("input", () => {
        autoResizeTextarea(el);
        updateAction(Number(el.dataset.index), (item) => ({
          ...item,
          action: withCandidatePatch(item.action, { title: el.value }),
        }));
        const missing = !el.value.trim();
        el.classList.toggle("missing", missing);
        el.toggleAttribute("aria-invalid", missing);
        syncReviewControls();
      });
      // A title is one line; Enter finishes editing it instead of adding a
      // line break Google Calendar would just flatten anyway.
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing && !(e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          el.blur();
        }
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-location").forEach((el) => {
      el.addEventListener("input", () => {
        updateAction(Number(el.dataset.index), (item) => ({
          ...item,
          action: withCandidatePatch(item.action, { location: el.value }),
        }));
      });
    });
    // Timed rows follow endForNewStart (the end stays put unless the start
    // passes it, then keeps the length); all-day rows move in whole days,
    // keeping their span.
    document.querySelectorAll<HTMLInputElement>(".cand-start").forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.value) return;
        const i = Number(el.dataset.index);
        const before = conflictKey(live()?.confirming?.actions[i]);
        const actions = updateAction(i, (item) => {
          if (item.action.type === "delete") return item;
          const { start, end } = item.action.candidate;
          if (isDateOnly(start)) {
            const days = Math.round((parseEventDate(end).getTime() - parseEventDate(start).getTime()) / 86400000);
            return { ...item, action: withCandidatePatch(item.action, { start: el.value, end: addDays(el.value, Math.max(days, 1)) }), conflicts: undefined };
          }
          const newStart = fromDatetimeLocalValue(el.value);
          return {
            ...item,
            action: withCandidatePatch(item.action, { start: newStart, end: endForNewStart(item.action.candidate, newStart) }),
            conflicts: undefined,
          };
        });
        if (!actions) return;
        const action = actions[i].action;
        if (action.type !== "delete") {
          const endInput = document.querySelector<HTMLInputElement>(`.cand-end[data-index="${i}"]`);
          if (endInput) {
            const allDay = isDateOnly(action.candidate.start);
            endInput.value = allDay ? toDateValue(lastAllDay(action.candidate.end)) : toDatetimeLocalValue(action.candidate.end);
            if (allDay) endInput.min = action.candidate.start;
          }
        }
        syncTimeSummary(i, action);
        recheckConflicts(actions, i, before);
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-end").forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.value) return;
        const i = Number(el.dataset.index);
        const before = conflictKey(live()?.confirming?.actions[i]);
        const actions = updateAction(i, (item) => {
          if (item.action.type === "delete") return item;
          // The date input shows the last day; Google wants the day after.
          const end = isDateOnly(item.action.candidate.start) ? addDays(el.value, 1) : fromDatetimeLocalValue(el.value);
          return { ...item, action: withCandidatePatch(item.action, { end }), conflicts: undefined };
        });
        if (!actions) return;
        syncTimeSummary(i, actions[i].action);
        recheckConflicts(actions, i, before);
      });
    });
    // Switching between all-day and timed swaps the input types, so this
    // one re-renders (focus comes back to the toggle by class + index).
    // Timed → all-day keeps the start's day; all-day → timed lands on 9 AM
    // for an hour, like Google Calendar's own toggle.
    document.querySelectorAll<HTMLInputElement>(".cand-allday").forEach((el) => {
      el.addEventListener("change", () => {
        const s = live();
        const i = Number(el.dataset.index);
        const item = s?.confirming?.actions[i];
        if (!s?.confirming || !item || item.action.type === "delete") return;
        const { start } = item.action.candidate;
        // A row with no date yet starts from today.
        const day = toDateValue(Number.isNaN(Date.parse(start)) ? new Date() : parseEventDate(start));
        let patch: { start: string; end: string };
        if (el.checked) {
          patch = { start: day, end: addDays(day, 1) };
        } else {
          const d = parseEventDate(day);
          const nine = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9);
          patch = { start: nine.toISOString(), end: new Date(nine.getTime() + 3600000).toISOString() };
        }
        const before = conflictKey(item);
        const actions = s.confirming.actions.map((a, idx) =>
          idx === i ? { ...a, action: withCandidatePatch(a.action, patch), conflicts: undefined } : a,
        );
        pendingFocus = `.cand-allday[data-index="${i}"]`;
        openTimeEditor = i;
        setState({ ...s, confirming: { ...s.confirming, actions, dirty: true } });
        openTimeEditor = null;
        recheckConflicts(actions, i, before);
      });
    });
  }

  if (current.answer !== undefined) {
    document.getElementById("answer-dismiss")?.addEventListener("click", () => {
      const s = live();
      if (s) closeAnswer(s);
    });
  }
}

render();
init();
