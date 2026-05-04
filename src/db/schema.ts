/**
 * Database schema for Pocket Claude v2.
 *
 * Single-user, no auth tables. Conversations and messages are the core
 * domain. Tool events were stored in their own table in earlier
 * versions; the simplified ManagedQuery doesn't surface tool activity
 * to the UI, so the table is gone.
 */

import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  title: text("title"),
  sessionId: text("session_id"),
  cwd: text("cwd"),
  status: text("status", { enum: ["idle", "running", "stopped", "error"] })
    .notNull()
    .default("idle"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  status: text("status", {
    enum: ["running", "complete", "stopped", "error"],
  })
    .notNull()
    .default("running"),
  content: text("content"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
