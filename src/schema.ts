/**
 * Database schema for Remote Claude v2.
 *
 * Single-user, no auth tables. Conversations and messages are the core
 * domain. Tool events are stored separately so durable execution works -
 * the client can disconnect and catch up on what happened via REST.
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title"),
  sessionId: text("session_id"),
  cwd: text("cwd"),
  status: text("status", { enum: ["idle", "running", "stopped", "error"] }).notNull().default("idle"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * Tool events are stored per-message so the client can reconstruct
 * what happened during a prompt execution, even if it wasn't connected.
 */
export const toolEvents = sqliteTable("tool_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  messageId: text("message_id").references(() => messages.id),
  toolName: text("tool_name").notNull(),
  toolId: text("tool_id").notNull(),
  input: text("input"),
  status: text("status", { enum: ["running", "complete", "error"] }).notNull().default("running"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
