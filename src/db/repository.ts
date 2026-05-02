/**
 * All database read/write operations in one place.
 *
 * The process-manager and routes both need to persist and query data.
 * Rather than scattering drizzle calls across the codebase, everything
 * goes through here. This makes DB access testable and keeps the rest
 * of the app decoupled from the ORM.
 */

import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "./index";
import { conversations, messages, toolEvents } from "./schema";

// -- Conversations --

export async function createConversation(id: string, cwd: string): Promise<void> {
  const db = getDb();
  await db.insert(conversations).values({
    id,
    cwd,
    status: "running",
  });
}

export async function getConversation(conversationId: string) {
  const db = getDb();
  const rows = await db.select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return rows[0];
}

export async function listConversations(limit = 50) {
  const db = getDb();
  return db.select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function updateConversationStatus(
  conversationId: string,
  status: "idle" | "running" | "stopped" | "error",
  sessionId?: string
): Promise<void> {
  const db = getDb();
  const updates: Record<string, unknown> = {
    status,
    updatedAt: sql`now()`,
  };
  if (sessionId !== undefined) {
    updates.sessionId = sessionId;
  }
  await db.update(conversations)
    .set(updates)
    .where(eq(conversations.id, conversationId));
}

// -- Messages --
//
// Assistant message writes happen inside MessageSession (full lifecycle).
// User messages are atomic (no lifecycle), so they go through here.

export async function insertUserMessage(
  id: string,
  conversationId: string,
  content: string,
): Promise<void> {
  const db = getDb();
  await db.insert(messages).values({
    id,
    conversationId,
    role: "user",
    status: "complete",
    content,
  });
}

export async function getMessages(conversationId: string) {
  const db = getDb();
  return db.select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

// -- Tool events --
//
// Tool event writes happen inside MessageSession (each event belongs to
// exactly one assistant message and shares its lifecycle). Reads stay
// here for REST catch-up.

export async function getToolEvents(conversationId: string) {
  const db = getDb();
  return db.select()
    .from(toolEvents)
    .where(eq(toolEvents.conversationId, conversationId))
    .orderBy(toolEvents.createdAt);
}
