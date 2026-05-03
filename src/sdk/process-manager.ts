/**
 * Manages Claude Code SDK agent sessions.
 *
 * Each prompt spawns one SDK query. The process manager tracks active
 * processes so they can be stopped on demand and orchestrates the flow
 * between the SDK and a MessageSession (which owns the assistant
 * message lifecycle, DB writes, and SSE emission).
 *
 * Only one prompt runs at a time per conversation. If a conversation
 * already has an active process, new prompts are rejected.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as repository from "../db/repository";
import { EventMapper } from "./event-mapper";
import { MessageSession } from "./message-session";

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
  session: MessageSession;
  abortController: AbortController;
  /** Resolves when executePrompt finishes (terminal write done). */
  done: Promise<void>;
}

/** Active SDK processes keyed by conversation ID. */
const activeProcesses = new Map<string, ActiveProcess>();

/** Check if a conversation has an active SDK process running. */
export function isRunning(conversationId: string): boolean {
  return activeProcesses.has(conversationId);
}

/** Stop an active SDK process. The catch path in executePrompt drives the message terminal. */
export function stop(conversationId: string): boolean {
  const active = activeProcesses.get(conversationId);
  if (!active) return false;

  active.abortController.abort();
  return true;
}

/**
 * Shutdown helper: abort every active SDK process and wait for each one
 * to finish writing its terminal state to the DB. Used by the signal
 * handler so partial text and stopped/error transitions land before the
 * connection pool drains.
 */
export async function abortAllAndWait(): Promise<void> {
  const all = Array.from(activeProcesses.values());
  for (const p of all) {
    p.abortController.abort();
  }
  await Promise.all(all.map((p) => p.done));
}

/**
 * Run a prompt through the Claude Code SDK.
 *
 * Inserts the user message, creates a MessageSession for the assistant
 * response, and spawns the SDK iteration in the background. The client
 * does not need to be connected for any of this to work - the message
 * lifecycle persists independently.
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
  await repository.insertUserMessage(userMessageId, conversationId, promptText);

  const session = await MessageSession.create(conversationId);
  const abortController = new AbortController();

  const convId = conversationId;
  const done = executePrompt(convId, session, promptText, abortController)
    .catch((error) => {
      console.error(`SDK execution error for ${convId}:`, error);
    });

  activeProcesses.set(conversationId, { session, abortController, done });

  return { conversationId: convId, messageId: session.id };
}

/**
 * Internal: drive the SDK iterator, route events into the MessageSession.
 * The session owns DB writes and SSE emission - this function is just wiring.
 */
async function executePrompt(
  conversationId: string,
  session: MessageSession,
  promptText: string,
  abortController: AbortController
): Promise<void> {
  const mapper = new EventMapper();

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

    const sdkSession = query({ prompt: promptText, options });

    for await (const event of sdkSession) {
      // High-level assistant message: contains the full text content for
      // this turn in `text` blocks. This is the canonical source for the
      // assistant's response - more reliable than reconstructing from
      // streaming text deltas.
      if (event.type === "assistant") {
        const blocks = (event as any).message?.content ?? [];
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            session.appendContent(block.text);
          }
        }
      } else if (event.type === "stream_event") {
        // Stream events still drive tool lifecycle (tool_start / partial
        // input / tool_complete) - we ignore their text deltas because
        // the assistant event above gives us the full text deterministically.
        const sdkEvent = (event as any).event;
        const mapped = mapper.map(sdkEvent);
        if (mapped) {
          if (mapped.type === "tool_start") {
            await session.toolStarted(mapped.toolName, mapped.toolId);
          } else if (mapped.type === "tool_complete") {
            await session.toolCompleted(mapped.toolId, mapped.input);
          }
        }
      } else if (event.type === "result") {
        const resultEvent = event as any;
        const sessionId = resultEvent.session_id || conversation?.sessionId || "";
        await session.complete(sessionId);
        return;
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      await session.stop();
      return;
    }
    await session.fail(error instanceof Error ? error : new Error(String(error)));
  } finally {
    clearTimeout(timeoutId);
    activeProcesses.delete(conversationId);
  }
}
