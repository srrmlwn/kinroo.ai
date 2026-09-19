import { clearSession, getSessionToken } from "../auth";
import { getMe, parseText, parseFile, createEvents, ApiError } from "../api";
import type { EventCandidate } from "../types";

interface EditableCandidate extends EventCandidate {
  selected: boolean;
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
  render();
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

async function init() {
  const token = await getSessionToken();
  if (!token) {
    setState({ kind: "unauthenticated" });
    return;
  }
  try {
    const me = await getMe();
    setState({ kind: "ready", email: me.email });
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
      setState({
        kind: "confirming",
        email: current.email,
        candidates: result.candidates.map((c) => ({ ...c, selected: true })),
      });
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
    <button id="submit" class="primary" ${view.busy ? "disabled" : ""}>${view.busy ? "Working…" : "Add"}</button>
  `;
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
          idx === i ? { ...c, start: fromDatetimeLocalValue(el.value) } : c,
        );
        setState({ ...current, candidates });
      });
    });
    document.querySelectorAll<HTMLInputElement>(".cand-end").forEach((el) => {
      el.addEventListener("change", () => {
        const i = Number(el.dataset.index);
        const candidates = current.candidates.map((c, idx) =>
          idx === i ? { ...c, end: fromDatetimeLocalValue(el.value) } : c,
        );
        setState({ ...current, candidates });
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
