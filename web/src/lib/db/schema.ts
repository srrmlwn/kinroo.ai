import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  googleAccountId: text("google_account_id").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  pictureUrl: text("picture_url"),
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
  // Whether each channel writes straight to the calendar and reports back
  // (with one-click undo), or holds changes for review first. Email defaults
  // to writing directly: a reply-to-confirm round trip is slow, easy to
  // miss, and every change is cheap to undo. The extension defaults to its
  // review screen, where confirming is one click. See SPEC.md → Auto-apply.
  // Unused — superseded by the two flags below. Left in place so the
  // deployment that's live while migrations run keeps working (it still
  // reads this column); drop it in a later migration.
  confirmBeforeWrite: boolean("confirm_before_write").notNull().default(true),
  emailAutoApply: boolean("email_auto_apply").notNull().default(true),
  extensionAutoApply: boolean("extension_auto_apply").notNull().default(false),
  defaultCalendarId: text("default_calendar_id").notNull().default("primary"),
});

// address -> user_id lookup, kept separate from `users` per SPEC.md's
// family-readiness notes so multiple addresses (and later, multiple people)
// can eventually resolve to a calendar's user without restructuring `users`.
// Seeded from the account's own Google email at OAuth time; nothing writes
// to it beyond that in v1.
export const emailIdentities = pgTable("email_identities", {
  address: text("address").primaryKey(), // lowercased
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A create/update/delete parsed from an inbound email, held for the
// reply-to-confirm flow (lib/email.ts, api/email/inbound) rather than
// written immediately — confirm-before-write is a hard rule with no panel
// UI available over email. `action` is an EventAction (see
// google-calendar.ts); stored as jsonb since it's a small write-once queue,
// not data anything else queries by field.
export const pendingEmailActions = pgTable("pending_email_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  action: jsonb("action").notNull(),
  status: text("status").notNull().default("pending"), // 'pending' | 'confirmed' | 'canceled' | 'expired'
  fromAddress: text("from_address").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Everything kinroo did in response to one inbound email when email
// auto-apply is on (settings.email_auto_apply): which events it added,
// changed, or canceled, plus the ones it held back (missing a date, or
// already on the calendar). The numbered summary email is rendered from
// `items`, and undo links / free-text replies act on it by item number —
// see lib/email-batch.ts. Kept after the fact too, as the record of how
// often auto-applied changes get undone or edited.
export const emailBatches = pgTable("email_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  fromAddress: text("from_address").notNull(),
  subject: text("subject").notNull(),
  items: jsonb("items").notNull(), // BatchItem[] (lib/email-batch.ts)
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Landing-page waitlist — deliberately outside the users/oauth_tokens graph
// (no userId, no auth): this is a pre-signup marketing capture, not part of
// the product's own data model.
export const waitlistSignups = pgTable("waitlist_signups", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
