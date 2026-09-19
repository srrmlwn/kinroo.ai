import { db } from "./db";
import { llmCalls } from "./db/schema";

// Rough per-model pricing, USD per token. Update as pricing changes —
// this is only for telemetry, never billed to the user directly.
const COST_PER_TOKEN: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.8 / 1_000_000, output: 4.0 / 1_000_000 },
  "claude-sonnet-5": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  "claude-opus-5": { input: 15.0 / 1_000_000, output: 75.0 / 1_000_000 },
};

export interface LlmCallLog {
  userId: string | null;
  channel: string;
  inputType: "text" | "image" | "pdf";
  usedLlm: boolean;
  model?: string;
  intent: "create" | "query" | "unknown";
  candidateCount: number;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  error?: string;
}

// Fire-and-forget — telemetry must never add latency or fail the
// user-facing response.
export function logLlmCall(log: LlmCallLog): void {
  const pricing = log.model ? COST_PER_TOKEN[log.model] : undefined;
  const costUsd =
    pricing && log.promptTokens != null && log.completionTokens != null
      ? (log.promptTokens * pricing.input + log.completionTokens * pricing.output).toFixed(6)
      : null;

  db.insert(llmCalls)
    .values({
      userId: log.userId,
      channel: log.channel,
      inputType: log.inputType,
      usedLlm: log.usedLlm,
      model: log.model,
      intent: log.intent,
      candidateCount: log.candidateCount,
      promptTokens: log.promptTokens,
      completionTokens: log.completionTokens,
      latencyMs: log.latencyMs,
      costUsd,
      error: log.error,
    })
    .catch((err) => console.error("[llm-log] failed to record call:", err));
}
