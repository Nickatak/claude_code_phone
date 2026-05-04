/**
 * REST + SSE routes for conversation management.
 *
 * Thin HTTP layer. Validates input, delegates to the repository for
 * data access, and to the process-manager for SDK operations. No
 * direct database imports - everything goes through the repository.
 */

import { Router } from "express";
import * as repository from "../db/repository";
import { subscribe } from "../sse/emitter";
import { runPrompt, stop, isRunning } from "../sdk/process-manager";
import type { SSEEvent } from "../sse/types";

export const conversationRouter = Router();

/** List all conversations, most recent first. */
conversationRouter.get("/", async (_req, res) => {
  try {
    const rows = await repository.listConversations();
    res.json(rows);
  } catch (error) {
    console.error("Failed to list conversations:", error);
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

/** Get messages for a conversation. */
conversationRouter.get("/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id as string;
    const rows = await repository.getMessages(conversationId);
    res.json(rows);
  } catch (error) {
    console.error("Failed to get messages:", error);
    res.status(500).json({ error: "Failed to get messages" });
  }
});

/** Send a message to a conversation (or create a new one). */
conversationRouter.post("/:id/messages", async (req, res) => {
  try {
    const conversationId =
      req.params.id === "new" ? undefined : (req.params.id as string);
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const result = await runPrompt(conversationId, message);
    res.status(202).json(result);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
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
conversationRouter.get("/:id/status", async (req, res) => {
  const conversationId = req.params.id as string;
  const running = isRunning(conversationId);

  try {
    const conversation = await repository.getConversation(conversationId);

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    res.json({
      status: running ? "running" : conversation.status,
      sessionId: conversation.sessionId,
    });
  } catch (error) {
    console.error("Failed to get conversation status:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

/**
 * SSE endpoint for the terminal message_transition event.
 *
 * The client opens this connection after a POST /messages and waits
 * for the single transition event. If the client disconnects, the SDK
 * keeps running - the result lands in the DB and the client can fetch
 * it via GET /messages on reconnect.
 */
conversationRouter.get("/:id/events", (req, res) => {
  const conversationId = req.params.id as string;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const unsubscribe = subscribe(conversationId, (event: SSEEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
  });
});
