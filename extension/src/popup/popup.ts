import { clearSession, getSessionToken } from "../auth";
import { getMe, parseText, parseFile, createEvents, ApiError } from "../api";
import { annotateConflicts } from "../conflicts";
import type { EventCandidate, CalendarEvent } from "../types";

interface EditableCandidate extends EventCandidate {
  selected: boolean;
  conflicts?: CalendarEvent[];
}

type View =
  | { kind: "loading" }
  | { kind: "unauthenticated"; error?: string }
  | { kind: "ready"; email: string; pendingFile?: File; busy?: boolean; notice?: string }
  | { kind: "confirming"; email: string; candidates: EditableCandidate[]; busy?: boolean; error?: string }
  | { kind: "answer"; email: string; text: string };

let state: View = { kind: "loading" };
let inputText = "";

const root = document.getElementById("root");
if (!root) throw new Error("popup root element missing");

function setState(next: View) {
  state = next;
  persistDraft(next);
  render();
}

// The popup is a transient Chrome action popup: it's destroyed on any focus
// loss (switching tabs, clicking another window), not just during OAuth.
// So anything worth not losing mid-compose gets mirrored to storage here and
// restored in init() when the popup is reopened. pendingFile (a File) can't
// be serialized, so an attached-but-unparsed file is the one thing this
// doesn't cover — everything after parsing (candidates, answers) does.
function persistDraft(view: View) {
  let payload: unknown = null;
  if (view.kind === "confirming") {
    payload = { kind: "confirming", candidates: view.candidates };
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
// page you were looking at when you opened the popup, so the common case
// (select a line, click the icon, hit Go) doesn't require the right-click
// menu at all. Falls back to the whole page's visible text when nothing is
// selected, so clicking the icon on an open invite/itinerary page still
// prefills something worth editing. activeTab makes this a one-off, no
// standing host access. Fails silently on chrome://, the Chrome Web Store,
// PDFs, etc. — those just get a blank compose box, same as before this
// existed.
const MAX_PAGE_SCAN_CHARS = 4000;

async function readPageContent(): Promise<{ text: string; scanned: boolean }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { text: "", scanned: false };
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selection = window.getSelection()?.toString().trim() ?? "";
        if (selection) return { text: selection, scanned: false };
        return { text: document.body?.innerText ?? "", scanned: true };
      },
    });
    const result = injection?.result as { text: string; scanned: boolean } | undefined;
    if (!result) return { text: "", scanned: false };
    return {
      text: result.text.trim().slice(0, MAX_PAGE_SCAN_CHARS),
      scanned: result.scanned,
    };
  } catch {
    return { text: "", scanned: false };
  }
}

async function init() {
  const token = await getSessionToken();
  if (!token) {
    setState({ kind: "unauthenticated" });
    return;
  }
  try {
    const me = await getMe();
    const { draft } = await chrome.storage.local.get("draft");
    if (draft?.kind === "confirming" && Array.isArray(draft.candidates) && draft.candidates.length > 0) {
      setState({ kind: "confirming", email: me.email, candidates: draft.candidates });
      return;
    }
    if (draft?.kind === "answer" && typeof draft.text === "string") {
      setState({ kind: "answer", email: me.email, text: draft.text });
      return;
    }
    inputText = draft?.kind === "ready" && typeof draft.inputText === "string" ? draft.inputText : "";
    let scannedPage = false;
    if (!inputText) {
      const page = await readPageContent();
      inputText = page.text;
      scannedPage = page.scanned && page.text.length > 0;
    }
    setState({
      kind: "ready",
      email: me.email,
      notice: scannedPage ? "Scanned this page — edit or clear before sending." : undefined,
    });
  } catch {
    await clearSession();
    setState({ kind: "unauthenticated" });
  }
}

async function handleConnect() {
  setState({ kind: "loading" });
  try {
    // Runs in the background worker, not here — chrome.identity's consent
    // window steals focus, and Chrome would close this popup (killing an
    // in-popup fetch/storage.set) before the flow finished.
    const result = await chrome.runtime.sendMessage({ type: "connect-google" });
    if (!result?.ok) throw new Error(result?.error ?? "Sign-in failed");
    setState({ kind: "ready", email: result.email });
  } catch (err) {
    setState({
      kind: "unauthenticated",
      error: err instanceof Error ? err.message : "Sign-in failed",
    });
  }
}

async function handleSignOut() {
  await clearSession();
  setState({ kind: "unauthenticated" });
}

async function handleSubmit(current: Extract<View, { kind: "ready" }>) {
  if (!inputText.trim() && !current.pendingFile) return;
  setState({ ...current, busy: true });
  try {
    const result = current.pendingFile
      ? await parseFile(current.pendingFile)
      : await parseText(inputText.trim());

    if (result.intent === "query") {
      inputText = "";
      setState({ kind: "answer", email: current.email, text: result.answer ?? "Nothing found." });
    } else if (result.intent === "create" && result.candidates.length > 0) {
      inputText = "";
      const candidates = await annotateConflicts(
        result.candidates.map((c) => ({ ...c, selected: true })),
      );
      setState({ kind: "confirming", email: current.email, candidates });
    } else {
      setState({
        ...current,
        pendingFile: undefined,
        busy: false,
        notice: "Couldn't find an event or question in that — try rephrasing.",
      });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await clearSession();
      setState({ kind: "unauthenticated", error: "Session expired — please reconnect" });
      return;
    }
    setState({
      ...current,
      busy: false,
      notice: err instanceof Error ? err.message : "Something went wrong",
    });
  }
}

// Fires after a start/end edit; the row already re-rendered without a
// conflict badge, this fills it back in once the check comes back. Guards
// on view kind since the popup may have moved on (confirm/cancel) by then.
function recheckConflicts(candidates: EditableCandidate[]): void {
  annotateConflicts(candidates).then((annotated) => {
    if (state.kind === "confirming") setState({ ...state, candidates: annotated });
  });
}

async function handleConfirm(current: Extract<View, { kind: "confirming" }>) {
  const selected = current.candidates.filter((c) => c.selected);
  if (selected.length === 0) return;
  setState({ ...current, busy: true, error: undefined });
  try {
    const result = await createEvents(selected);
    const failures = result.events.filter((e) => !e.ok);
    if (failures.length > 0) {
      setState({
        ...current,
        busy: false,
        error: `${failures.length} of ${selected.length} event(s) failed to save. Try again?`,
      });
      return;
    }
    setState({ kind: "ready", email: current.email, notice: `Added ${selected.length} event(s).` });
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

function renderUnauthenticated(view: Extract<View, { kind: "unauthenticated" }>): string {
  return `
    <p class="lead">Turn plain English into Google Calendar events.</p>
    ${view.error ? `<p class="notice error">${escapeHtml(view.error)}</p>` : ""}
    <button id="connect" class="primary">Connect Google Calendar</button>
  `;
}

function renderReady(view: Extract<View, { kind: "ready" }>): string {
  return `
    <div class="account-row">
      <span class="email">${escapeHtml(view.email)}</span>
      <button id="signout" class="link">Sign out</button>
    </div>
    ${view.notice ? `<p class="notice">${escapeHtml(view.notice)}</p>` : ""}
    <textarea id="text-input" rows="3" placeholder="Doctor's appointment at 9am tomorrow, or ask 'what's on Saturday?'" ${view.busy ? "disabled" : ""}>${escapeHtml(inputText)}</textarea>
    ${
      view.pendingFile
        ? `<div class="file-chip">${escapeHtml(view.pendingFile.name)} <button id="remove-file" class="link">remove</button></div>`
        : `<label class="file-label">
             <input id="file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" ${view.busy ? "disabled" : ""} />
             Attach a screenshot, photo, or PDF
           </label>`
    }
    <button id="submit" class="primary" ${view.busy ? "disabled" : ""}>${view.busy ? "Working…" : "Go"}</button>
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

// Turns an RRULE into a short human-readable summary for the confirm list —
// not a full RFC 5545 renderer, just enough for the common cases the
// extraction schema actually produces (FREQ/INTERVAL/BYDAY/COUNT/UNTIL).
function formatRecurrence(rule: string): string {
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
  return label;
}

function renderConfirming(view: Extract<View, { kind: "confirming" }>): string {
  const rows = view.candidates
    .map(
      (c, i) => `
      <div class="candidate" data-index="${i}">
        <label class="candidate-select">
          <input type="checkbox" class="cand-selected" data-index="${i}" ${c.selected ? "checked" : ""} />
        </label>
        <div class="candidate-fields">
          <input type="text" class="cand-title" data-index="${i}" value="${escapeAttr(c.title)}" />
          <div class="candidate-times">
            <input type="datetime-local" class="cand-start" data-index="${i}" value="${toDatetimeLocalValue(c.start)}" />
            <span>–</span>
            <input type="datetime-local" class="cand-end" data-index="${i}" value="${toDatetimeLocalValue(c.end)}" />
          </div>
          ${
            c.recurrence?.length
              ? `<p class="recurrence-note">🔁 ${escapeHtml(formatRecurrence(c.recurrence[0]))}</p>`
              : ""
          }
          ${
            c.conflicts?.length
              ? `<p class="conflict-warning">⚠ Overlaps "${escapeHtml(c.conflicts[0].title)}"${c.conflicts.length > 1 ? ` +${c.conflicts.length - 1} more` : ""}</p>`
              : ""
          }
        </div>
      </div>`,
    )
    .join("");

  const selectedCount = view.candidates.filter((c) => c.selected).length;

  return `
    <p class="lead">${view.candidates.length > 1 ? `${view.candidates.length} events found — review before adding.` : "Review before adding."}</p>
    <div class="candidates">${rows}</div>
    ${view.error ? `<p class="notice error">${escapeHtml(view.error)}</p>` : ""}
    <div class="confirm-actions">
      <button id="cancel" class="link" ${view.busy ? "disabled" : ""}>Cancel</button>
      <button id="confirm" class="primary" ${view.busy || selectedCount === 0 ? "disabled" : ""}>
        ${view.busy ? "Adding…" : `Add ${selectedCount} event${selectedCount === 1 ? "" : "s"}`}
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

  attachHandlers();
}

function attachHandlers() {
  if (state.kind === "unauthenticated") {
    document.getElementById("connect")?.addEventListener("click", handleConnect);
  }

  if (state.kind === "ready") {
    const current = state;
    document.getElementById("signout")?.addEventListener("click", handleSignOut);
    document.getElementById("submit")?.addEventListener("click", () => handleSubmit(current));
    document.getElementById("remove-file")?.addEventListener("click", () => {
      setState({ ...current, pendingFile: undefined });
    });

    const textInput = document.getElementById("text-input") as HTMLTextAreaElement | null;
    textInput?.addEventListener("input", (e) => {
      inputText = (e.target as HTMLTextAreaElement).value;
      persistDraft(state);
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
            setState({ ...current, pendingFile: file });
          }
          return;
        }
      }
    });

    const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
    fileInput?.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) setState({ ...current, pendingFile: file });
    });
  }

  if (state.kind === "confirming") {
    const current = state;
    document.getElementById("cancel")?.addEventListener("click", () => {
      setState({ kind: "ready", email: current.email });
    });
    document.getElementById("confirm")?.addEventListener("click", () => handleConfirm(current));

    document.querySelectorAll<HTMLInputElement>(".cand-selected").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const candidates = current.candidates.map((c, idx) =>
          idx === i ? { ...c, selected: el.checked } : c,
        );
        setState({ ...current, candidates });
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-title").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const candidates = current.candidates.map((c, idx) =>
          idx === i ? { ...c, title: el.value } : c,
        );
        setState({ ...current, candidates });
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-start").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const candidates = current.candidates.map((c, idx) =>
          idx === i ? { ...c, start: fromDatetimeLocalValue(el.value), conflicts: undefined } : c,
        );
        setState({ ...current, candidates });
        recheckConflicts(candidates);
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-end").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const candidates = current.candidates.map((c, idx) =>
          idx === i ? { ...c, end: fromDatetimeLocalValue(el.value), conflicts: undefined } : c,
        );
        setState({ ...current, candidates });
        recheckConflicts(candidates);
      });
    });
  }

  if (state.kind === "answer") {
    const current = state;
    document.getElementById("new-query")?.addEventListener("click", () => {
      setState({ kind: "ready", email: current.email });
    });
  }
}

render();
init();
