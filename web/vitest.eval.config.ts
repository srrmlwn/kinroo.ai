import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Evals call the real Claude API, so they're kept out of `npm test` (which
// only picks up *.test.ts) and run on demand via `npm run eval:query`.
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    env: loadEnv("", process.cwd(), ""),
    testTimeout: 600_000,
  },
});
