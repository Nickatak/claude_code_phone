import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["worker", "client"] }).notNull(),
  role: text("role", { enum: ["admin", "chat"] }).notNull().default("chat"),
  token: text("token").notNull().unique(),
  sandbox: text("sandbox"),
  lastSeen: text("last_seen"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").references(() => devices.id),
  title: text("title"),
  sessionId: text("session_id"),
  cwd: text("cwd"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  toolUse: text("tool_use"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
