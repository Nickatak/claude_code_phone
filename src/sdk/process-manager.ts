/**
 * Manages Claude Code SDK child processes.
 *
 * Each prompt spawns one SDK query. The process manager tracks active
 * processes so they can be stopped on demand, writes tool events and
 * results to the database as they happen (durable execution), and
 * emits SSE events to any connected clients.
 *
 * Only one prompt runs at a time per conversation. If a conversation
 * already has an active process, new prompts are rejected.
 */

import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "../db";
import { conversations, messages, toolEvents } from "../schema";
import { mapSdkEvent, type ActiveTool } from "./event-mapper";
import type { SSEEvent, ActiveProcess } from "../types";

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Active SDK processes keyed by conversation ID. */
const activeProcesses = new Map<string, ActiveProcess>();

/** SSE listeners keyed by conversation ID. Multiple clients can watch one conversation. */
const sseListeners = new Map<string, Set<(event: SSEEvent) => void>>();

/** Check if a conversation has an active SDK process running. */
export function isRunning(conversationId: string): boolean {
  return activeProcesses.has(conversationId);
}

/** Register an SSE listener for a conversation. Returns an unsubscribe function. */
export function subscribe(
  conversationId: string,
  listener: (event: SSEEvent) => void
): () => void {
  let listeners = sseListeners.get(conversationId);
  if (!listeners) {
    listeners = new Set();
    sseListeners.set(conversationId, listeners);
  }
  listeners.add(listener);

  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) {
      sseListeners.delete(conversationId);
    }
  };
}

/** Emit an SSE event to all listeners for a conversation. */
function emit(conversationId: string, event: SSEEvent): void {
  const listeners = sseListeners.get(conversationId);
  if (listeners) {
    for (const listener of listeners) {
      listener(event);
    }
  }
}

/** Stop an active SDK process. Writes partial state to DB. */
export function stop(conversationId: string): boolean {
  const process = activeProcesses.get(conversationId);
  if (!process) return false;

  process.abort();
  return true;
}

/**
 * Run a prompt through the Claude Code SDK.
 *
 * Creates the conversation and user message in the DB, spawns the SDK,
 * streams tool events to SSE listeners, and writes the final response
 * to the DB when complete. The client does not need to be connected
 * for any of this to work.
 */
export async function runPrompt(
  conversationId: string | undefined,
  promptText: string,
  cwd?: string
): Promise<{ conversationId: string; messageId: string }> {
  const db = getDb();

  // Create or reuse conversation
  if (!conversationId) {
    conversationId = randomUUID();
    db.insert(conversations).values({
      id: conversationId,
      cwd: cwd || process.env.HOME || "/home/nick",
      status: "running",
    }).run();
  } else {
    // Reject if already running
    if (activeProcesses.has(conversationId)) {
      throw new Error("Conversation already has an active prompt");
    }
    db.update(conversations)
      .set({ status: "running", updatedAt: new Date().toISOString() })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  // Store user message
  const userMessageId = randomUUID();
  db.insert(messages).values({
    id: userMessageId,
    conversationId,
    role: "user",
    content: promptText,
  }).run();

  // Prepare assistant message placeholder
  const assistantMessageId = randomUUID();

  // Abort controller for stop command
  let aborted = false;
  const abortFn = () => { aborted = true; };

  activeProcesses.set(conversationId, {
    conversationId,
    messageId: assistantMessageId,
    abort: abortFn,
  });

  // Run SDK in the background - don't await here so we can return immediately
  const convId = conversationId;
  executePrompt(convId, assistantMessageId, promptText, cwd, () => aborted)
    .catch((error) => {
      console.error(`SDK execution error for ${convId}:`, error);
    });

  return { conversationId: convId, messageId: assistantMessageId };
}

/**
 * Internal: runs the SDK query, processes events, writes to DB.
 * This is the long-running async operation that the stop command can abort.
 */
async function executePrompt(
  conversationId: string,
  assistantMessageId: string,
  promptText: string,
  cwd: string | undefined,
  isAborted: () => boolean
): Promise<void> {
  const db = getDb();
  const activeTools: Map<string, ActiveTool> = new Map();
  let fullText = "";

  // Look up session ID for conversation resumption
  const conversation = db.select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();

  const workingDirectory = cwd || conversation?.cwd || process.env.HOME || "/home/nick";

  // Timeout to prevent runaway processes
  const timeoutId = setTimeout(() => {
    const process = activeProcesses.get(conversationId);
    if (process) {
      process.abort();
    }
  }, PROMPT_TIMEOUT_MS);

  try {
    const options: Record<string, unknown> = {
      cwd: workingDirectory,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "user"],
      includePartialMessages: true,
    };

    if (conversation?.sessionId) {
      options.resume = conversation.sessionId;
    }

    const session = query({ prompt: promptText, options });
    const iterator = session[Symbol.asyncIterator]();

    while (true) {
      if (isAborted()) {
        // Write what we have so far
        db.insert(messages).values({
          id: assistantMessageId,
          conversationId,
          role: "assistant",
          content: fullText || "(stopped)",
        }).run();

        db.update(conversations)
          .set({ status: "stopped", updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, conversationId))
          .run();

        emit(conversationId, { type: "stopped" });
        return;
      }

      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;

      // Accumulate text from text deltas (we don't stream these to client)
      if (event.type === "stream_event") {
        const sdkEvent = (event as any).event;

        // Accumulate text silently
        if (
          sdkEvent?.type === "content_block_delta" &&
          sdkEvent.delta?.type === "text_delta"
        ) {
          fullText += sdkEvent.delta.text;
        }

        // Map tool events and emit + persist
        const mapped = mapSdkEvent(sdkEvent, activeTools);
        if (mapped) {
          if (mapped.type === "tool_start") {
            db.insert(toolEvents).values({
              conversationId,
              messageId: assistantMessageId,
              toolName: mapped.toolName,
              toolId: mapped.toolId,
              status: "running",
            }).run();
            emit(conversationId, mapped);
          } else if (mapped.type === "tool_complete") {
            db.update(toolEvents)
              .set({ input: mapped.input, status: "complete" })
              .where(eq(toolEvents.toolId, mapped.toolId))
              .run();
            emit(conversationId, mapped);
          }
        }
      } else if (event.type === "result") {
        const resultEvent = event as any;
        const sessionId = resultEvent.session_id || conversation?.sessionId || "";

        // Store the complete assistant message
        db.insert(messages).values({
          id: assistantMessageId,
          conversationId,
          role: "assistant",
          content: fullText,
        }).run();

        // Update conversation with session ID for future resumption
        db.update(conversations)
          .set({
            sessionId,
            status: "idle",
            updatedAt: new Date().toISOString(),
          })
          .where(eq(conversations.id, conversationId))
          .run();

        emit(conversationId, {
          type: "response_complete",
          messageId: assistantMessageId,
          content: fullText,
        });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Store error as assistant message so it's visible in history
    db.insert(messages).values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: `Error: ${errorMessage}`,
    }).run();

    db.update(conversations)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(conversations.id, conversationId))
      .run();

    emit(conversationId, { type: "error", message: errorMessage });
  } finally {
    clearTimeout(timeoutId);
    activeProcesses.delete(conversationId);
  }
}
