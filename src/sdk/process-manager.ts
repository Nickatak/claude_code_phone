/**
 * Manages Claude Code SDK agent sessions.
 *
 * Each prompt spawns one SDK query. The process manager tracks active
 * processes so they can be stopped on demand and orchestrates the flow
 * between the SDK, the database (via repository), and connected clients
 * (via SSE emitter).
 *
 * Only one prompt runs at a time per conversation. If a conversation
 * already has an active process, new prompts are rejected.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as repository from "../db/repository";
import * as emitter from "../sse/emitter";
import { EventMapper } from "./event-mapper";

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Phone-specific CLAUDE.md loaded at startup. Synced from the desktop
 * output style with the "write to disk" delivery rule rewritten for
 * chat-only delivery. Injected via systemPrompt.append so it coexists
 * with project-level CLAUDE.md files in any working directory.
 */
const PHONE_CLAUDE_MD = fs.readFileSync(
  path.join(__dirname, "..", "..", "config", "CLAUDE.md"),
  "utf-8"
);

/** Internal tracking for active SDK processes. */
interface ActiveProcess {
  conversationId: string;
  messageId: string;
  abortController: AbortController;
}

/** Active SDK processes keyed by conversation ID. */
const activeProcesses = new Map<string, ActiveProcess>();

/** Check if a conversation has an active SDK process running. */
export function isRunning(conversationId: string): boolean {
  return activeProcesses.has(conversationId);
}

/** Stop an active SDK process. The SDK handles cleanup via AbortController. */
export function stop(conversationId: string): boolean {
  const active = activeProcesses.get(conversationId);
  if (!active) return false;

  active.abortController.abort();
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
  promptText: string
): Promise<{ conversationId: string; messageId: string }> {
  const workingDirectory = process.env.DEFAULT_CWD || "/home/nick/learning/social_media";
  if (!conversationId) {
    conversationId = randomUUID();
    await repository.createConversation(conversationId, workingDirectory);
  } else {
    if (activeProcesses.has(conversationId)) {
      throw new Error("Conversation already has an active prompt");
    }
    await repository.updateConversationStatus(conversationId, "running");
  }

  const userMessageId = randomUUID();
  await repository.insertMessage(userMessageId, conversationId, "user", promptText);

  const assistantMessageId = randomUUID();
  const abortController = new AbortController();

  activeProcesses.set(conversationId, {
    conversationId,
    messageId: assistantMessageId,
    abortController,
  });

  const convId = conversationId;
  executePrompt(convId, assistantMessageId, promptText, abortController)
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
  abortController: AbortController
): Promise<void> {
  const mapper = new EventMapper();
  let fullText = "";

  const conversation = await repository.getConversation(conversationId);
  const workingDirectory = process.env.DEFAULT_CWD || "/home/nick/learning/social_media";

  // Timeout to prevent runaway processes
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, PROMPT_TIMEOUT_MS);

  try {
    const options: Record<string, unknown> = {
      cwd: workingDirectory,
      abortController,
      permissionMode: "bypassPermissions",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: PHONE_CLAUDE_MD,
      },
      settingSources: ["project"],
      includePartialMessages: true,
    };

    if (conversation?.sessionId) {
      options.resume = conversation.sessionId;
    }

    const session = query({ prompt: promptText, options });

    for await (const event of session) {
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
        const mapped = mapper.map(sdkEvent);
        if (mapped) {
          if (mapped.type === "tool_start") {
            await repository.insertToolEvent(conversationId, mapped.toolName, mapped.toolId);
            emitter.emit(conversationId, mapped);
          } else if (mapped.type === "tool_complete") {
            await repository.completeToolEvent(mapped.toolId, mapped.input);
            emitter.emit(conversationId, mapped);
          }
        }
      } else if (event.type === "result") {
        const resultEvent = event as any;
        const sessionId = resultEvent.session_id || conversation?.sessionId || "";

        // Store the complete assistant message
        await repository.insertMessage(assistantMessageId, conversationId, "assistant", fullText);

        // Update conversation with session ID for future resumption
        await repository.updateConversationStatus(conversationId, "idle", sessionId);

        emitter.emit(conversationId, {
          type: "response_complete",
          messageId: assistantMessageId,
          content: fullText,
        });
      }
    }
  } catch (error) {
    // AbortController.abort() causes the SDK to throw - treat as a stop
    if (abortController.signal.aborted) {
      await repository.insertMessage(
        assistantMessageId,
        conversationId,
        "assistant",
        fullText || "(stopped)"
      );
      await repository.updateConversationStatus(conversationId, "stopped");
      emitter.emit(conversationId, { type: "stopped" });
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Store error as assistant message so it's visible in history
    await repository.insertMessage(
      assistantMessageId,
      conversationId,
      "assistant",
      `Error: ${errorMessage}`
    );
    await repository.updateConversationStatus(conversationId, "error");
    emitter.emit(conversationId, { type: "error", message: errorMessage });
  } finally {
    clearTimeout(timeoutId);
    activeProcesses.delete(conversationId);
  }
}
