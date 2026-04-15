/**
 * REST + SSE routes for conversation management.
 *
 * Handles creating conversations, sending messages, fetching history,
 * stopping active prompts, and streaming tool events via SSE. All
 * persistence is in SQLite - clients can disconnect and catch up later.
 */

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, messages, toolEvents } from "../schema";
import { runPrompt, stop, isRunning, subscribe } from "../sdk/process-manager";
import type { SSEEvent } from "../types";

export const conversationRouter = Router();

/** List all conversations, most recent first. */
conversationRouter.get("/", (_req, res) => {
  try {
    const db = getDb();
    const rows = db.select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(50)
      .all();
    res.json(rows);
  } catch (error) {
    console.error("Failed to list conversations:", error);
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

/** Get messages for a conversation. */
conversationRouter.get("/:id/messages", (req, res) => {
  try {
    const db = getDb();
    const conversationId = req.params.id as string;
    const rows = db.select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .all();
    res.json(rows);
  } catch (error) {
    console.error("Failed to get messages:", error);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

/** Get tool events for a conversation. Used for catch-up after reconnect. */
conversationRouter.get("/:id/tools", (req, res) => {
  try {
    const db = getDb();
    const conversationId = req.params.id as string;
    const rows = db.select()
      .from(toolEvents)
      .where(eq(toolEvents.conversationId, conversationId))
      .orderBy(toolEvents.createdAt)
      .all();
    res.json(rows);
  } catch (error) {
    console.error("Failed to get tool events:", error);
    res.status(500).json({ error: "Failed to get tool events" });
  }
});

/** Send a message to a conversation (or create a new one). */
conversationRouter.post("/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id === "new" ? undefined : req.params.id as string;
    const { message, cwd } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const result = await runPrompt(conversationId, message, cwd);
    res.status(202).json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Failed to run prompt:", error);
    res.status(409).json({ error: errorMessage });
  }
});

/** Stop an active prompt. */
conversationRouter.post("/:id/stop", (req, res) => {
  const conversationId = req.params.id as string;
  const stopped = stop(conversationId);

  if (stopped) {
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "No active prompt for this conversation" });
  }
});

/** Get conversation status (running, idle, etc.). */
conversationRouter.get("/:id/status", (req, res) => {
  const conversationId = req.params.id as string;
  const running = isRunning(conversationId);

  try {
    const db = getDb();
    const conversation = db.select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    res.json({
      status: running ? "running" : conversation.status,
      sessionId: conversation.sessionId,
      cwd: conversation.cwd,
    });
  } catch (error) {
    console.error("Failed to get conversation status:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

/**
 * SSE endpoint for real-time tool events during prompt execution.
 *
 * The client opens this connection and receives events as the SDK runs.
 * If the client disconnects, the SDK keeps running - results land in
 * the DB and can be fetched via the REST endpoints above.
 */
conversationRouter.get("/:id/events", (req, res) => {
  const conversationId = req.params.id as string;

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  // Subscribe to events for this conversation
  const unsubscribe = subscribe(conversationId, (event: SSEEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Clean up when client disconnects
  req.on("close", () => {
    unsubscribe();
  });
});
