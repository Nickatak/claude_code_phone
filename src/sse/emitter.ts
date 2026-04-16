/**
 * SSE pub/sub for real-time event delivery to connected clients.
 *
 * The process-manager emits events here as the SDK runs. Route handlers
 * subscribe on behalf of SSE connections. Multiple clients can watch
 * the same conversation. If no one is listening, events are silently
 * dropped (the DB has the durable copy).
 */

import type { SSEEvent } from "./types";

/** SSE listeners keyed by conversation ID. Multiple clients can watch one conversation. */
const listeners = new Map<string, Set<(event: SSEEvent) => void>>();

/** Register an SSE listener for a conversation. Returns an unsubscribe function. */
export function subscribe(
  conversationId: string,
  listener: (event: SSEEvent) => void
): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);

  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      listeners.delete(conversationId);
    }
  };
}

/** Emit an SSE event to all listeners for a conversation. */
export function emit(conversationId: string, event: SSEEvent): void {
  const set = listeners.get(conversationId);
  if (set) {
    for (const listener of set) {
      listener(event);
    }
  }
}
