// Scaffold only — confirms the extension can reach the backend.
// The compose-to-create UI described in SPEC.md replaces this.
const API_BASE = "http://localhost:3000";

async function checkBackend(): Promise<void> {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    statusEl.textContent = "Backend connected";
    statusEl.className = "status ok";
  } catch {
    statusEl.textContent = "Backend unreachable — is the dev server running?";
    statusEl.className = "status error";
  }
}

checkBackend();
