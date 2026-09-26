import path from "node:path";
import { defineConfig } from "vitest/config";

// Only here so tests can import route handlers, which use the same "@/…"
// alias as tsconfig.json. Test discovery stays the default (*.test.ts);
// evals have their own config (vitest.eval.config.ts).
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
