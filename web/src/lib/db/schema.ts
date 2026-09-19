import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  googleAccountId: text("google_account_id").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const oauthTokens = pgTable("oauth_tokens", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // AES-256-GCM ciphertext, base64 — see lib/crypto.ts. Never store raw tokens.
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull(),
});

export const settings = pgTable("settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("UTC"),
  defaultEventDurationMin: integer("default_event_duration_min")
    .notNull()
    .default(30),
  // Always true in v1 — no UI to change it yet, but the column exists so
  // adding that UI later is additive, not a migration.
  confirmBeforeWrite: boolean("confirm_before_write").notNull().default(true),
  defaultCalendarId: text("default_calendar_id").notNull().default("primary"),
});

export const llmCalls = pgTable("llm_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  inputType: text("input_type").notNull(), // 'text' | 'image' | 'pdf'
  usedLlm: boolean("used_llm").notNull(),
  model: text("model"),
  intent: text("intent").notNull(), // 'create' | 'query' | 'unknown'
  candidateCount: integer("candidate_count").notNull().default(1),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  confirmed: boolean("confirmed"),
  userCorrected: boolean("user_corrected").notNull().default(false),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
