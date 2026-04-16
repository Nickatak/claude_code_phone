/**
 * All database read/write operations in one place.
 *
 * The process-manager and routes both need to persist and query data.
 * Rather than scattering drizzle calls across the codebase, everything
 * goes through here. This makes DB access testable and keeps the rest
 * of the app decoupled from the ORM.
 */

import { eq, desc } from "drizzle-orm";
import { getDb } from "./index";
import { conversations, messages, toolEvents } from "./schema";

// -- Conversations --

export function createConversation(id: string, cwd: string): void {
  const db = getDb();
  db.insert(conversations).values({
    id,
    cwd,
    status: "running",
  }).run();
}

export function getConversation(conversationId: string) {
  const db = getDb();
  return db.select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
}

export function listConversations(limit = 50) {
  const db = getDb();
  return db.select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
    .all();
}

export function updateConversationStatus(
  conversationId: string,
  status: "idle" | "running" | "stopped" | "error",
  sessionId?: string
): void {
  const db = getDb();
  const updates: Record<string, unknown> = {
    status,
    updatedAt: new Date().toISOString(),
  };
  if (sessionId !== undefined) {
    updates.sessionId = sessionId;
  }
  db.update(conversations)
    .set(updates)
    .where(eq(conversations.id, conversationId))
    .run();
}

// -- Messages --

export function insertMessage(
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string
): void {
  const db = getDb();
  db.insert(messages).values({
    id,
    conversationId,
    role,
    content,
  }).run();
}

export function getMessages(conversationId: string) {
  const db = getDb();
  return db.select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt)
    .all();
}

// -- Tool events --

export function insertToolEvent(
  conversationId: string,
  toolName: string,
  toolId: string
): void {
  const db = getDb();
  db.insert(toolEvents).values({
    conversationId,
    toolName,
    toolId,
    status: "running",
  }).run();
}

export function completeToolEvent(toolId: string, input: string): void {
  const db = getDb();
  db.update(toolEvents)
    .set({ input, status: "complete" })
    .where(eq(toolEvents.toolId, toolId))
    .run();
}

export function getToolEvents(conversationId: string) {
  const db = getDb();
  return db.select()
    .from(toolEvents)
    .where(eq(toolEvents.conversationId, conversationId))
    .orderBy(toolEvents.createdAt)
    .all();
}
