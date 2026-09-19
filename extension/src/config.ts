export interface ExtensionConfig {
  apiBase: string;
  googleClientId: string;
}

let cached: ExtensionConfig | null = null;

// config.json is bundled alongside the extension (copied by build.js from
// config.json, or config.example.json if the real one hasn't been created
// yet — see extension/README-less setup notes in the repo's SETUP.md).
export async function getConfig(): Promise<ExtensionConfig> {
  if (cached) return cached;
  const res = await fetch(chrome.runtime.getURL("config.json"));
  cached = (await res.json()) as ExtensionConfig;
  return cached;
}
