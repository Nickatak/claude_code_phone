/**
 * Tracks active ManagedQueries by conversation. Thin: creating a query,
 * stopping one, and a graceful-shutdown helper. The lifecycle, DB
 * persistence, and SSE emission live inside ManagedQuery itself.
 *
 * Only one prompt runs at a time per conversation. New prompts to a
 * conversation that already has an active ManagedQuery are rejected.
 */

import { randomUUID } from "crypto";
import * as repository from "../db/repository";
import { ManagedQuery } from "./managed_query";

const activeQueries = new Map<string, ManagedQuery>();

export function isRunning(conversationId: string): boolean {
  return activeQueries.has(conversationId);
}

export function stop(conversationId: string): boolean {
  const mq = activeQueries.get(conversationId);
  if (!mq) return false;
  mq.stop();
  return true;
}

/**
 * Abort every active ManagedQuery and wait for each one to finish
 * its terminal write. Used by the signal handler so partial state and
 * stopped/error transitions land before the connection pool drains.
 */
export async function abortAllAndWait(): Promise<void> {
  const all = Array.from(activeQueries.values());
  for (const mq of all) mq.stop();
  await Promise.all(all.map((mq) => mq.done));
}

export async function runPrompt(
  conversationId: string | undefined,
  promptText: string,
): Promise<{ conversationId: string; messageId: string }> {
  const cwd = process.env.DEFAULT_CWD || "/home/nick/learning/social_media";

  if (!conversationId) {
    conversationId = randomUUID();
    await repository.createConversation(conversationId, cwd);
  } else {
    if (activeQueries.has(conversationId)) {
      throw new Error("Conversation already has an active prompt");
    }
    await repository.updateConversationStatus(conversationId, "running");
  }

  const userMessageId = randomUUID();
  await repository.insertUserMessage(userMessageId, conversationId, promptText);

  const conversation = await repository.getConversation(conversationId);
  const resumeSessionId = conversation?.sessionId ?? undefined;

  const mq = await ManagedQuery.create(
    conversationId,
    cwd,
    resumeSessionId,
    promptText,
  );

  activeQueries.set(conversationId, mq);
  // Cleanup on terminal: remove from active map. Use done (not fin) so
  // stop()/error paths also clean up.
  void mq.done.finally(() => {
    activeQueries.delete(conversationId!);
  });

  return { conversationId, messageId: mq.id };
}
