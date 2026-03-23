import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * Devices represent any authenticated entity that connects to the relay.
 * This includes both the Claude Code worker (running on the PC) and
 * client devices (phones/browsers that users interact with).
 *
 * Each device has a unique token that serves as its login credential —
 * the token IS the device identity. When a user logs in, the relay
 * looks up the token in this table to determine who they are and
 * what they're allowed to do.
 */
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  /** Human-readable label, e.g. "Mom's iPhone", "WSL Worker" */
  name: text("name").notNull(),
  /** "worker" = Claude Code executor on the PC; "client" = browser/phone UI */
  type: text("type", { enum: ["worker", "client"] }).notNull(),
  /** "admin" = full Claude Code with all tools; "chat" = sandboxed, no system tools */
  role: text("role", { enum: ["admin", "chat"] }).notNull().default("chat"),
  /** Unique auth credential — typed by the user at login, looked up to identify the device */
  token: text("token").notNull().unique(),
  /** Absolute path to this device's sandboxed directory on the worker machine.
   *  Only relevant for chat-role devices. Claude can only read/write files within this path.
   *  Contains the user's CLAUDE.md (personality) and memory files. */
  sandbox: text("sandbox"),
  lastSeen: text("last_seen"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * Conversations are chat sessions between a user and Claude.
 * Each conversation belongs to a specific device (tenant isolation —
 * users only see their own conversations).
 *
 * Conversations persist across PC reboots. The sessionId allows the
 * Claude Code SDK to resume a conversation with full prior context
 * after the worker restarts.
 */
export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").references(() => devices.id),
  title: text("title"),
  /** Claude Code SDK session ID — stored so conversations can be resumed
   *  after worker crashes/reboots by passing this to the SDK's `resume` option */
  sessionId: text("session_id"),
  /** Working directory this conversation operates in.
   *  For admin: a project directory chosen from the picker.
   *  For chat: the sandbox path from the device. */
  cwd: text("cwd"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

/**
 * Messages are individual turns within a conversation.
 * Both user messages and assistant responses are stored here.
 * Tool call metadata is stored as JSON in toolUse for display purposes.
 */
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id),
  /** "user" = human input; "assistant" = Claude's response */
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  /** JSON-serialized array of tool calls made during this response (assistant only) */
  toolUse: text("tool_use"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});
