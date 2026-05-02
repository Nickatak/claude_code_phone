/**
 * Database schema for Pocket Claude v2.
 *
 * Single-user, no auth tables. Conversations and messages are the core
 * domain. Tool events are stored separately so durable execution works -
 * the client can disconnect and catch up on what happened via REST.
 */

import { pgTable, text, uuid, serial, timestamp } from "drizzle-orm/pg-core";

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  title: text("title"),
  sessionId: text("session_id"),
  cwd: text("cwd"),
  status: text("status", { enum: ["idle", "running", "stopped", "error"] }).notNull().default("idle"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  status: text("status", {
    enum: ["running", "complete", "stopped", "error"],
  }).notNull().default("running"),
  content: text("content"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tool events are stored per-message so the client can reconstruct
 * what happened during a prompt execution, even if it wasn't connected.
 */
export const toolEvents = pgTable("tool_events", {
  id: serial("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  toolName: text("tool_name").notNull(),
  toolId: text("tool_id").notNull(),
  input: text("input"),
  status: text("status", { enum: ["running", "complete", "error"] }).notNull().default("running"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
