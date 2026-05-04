/**
 * SSE event types pushed to connected clients.
 *
 * One terminal event per assistant message. No tool events, no
 * streaming text deltas - the simplified ManagedQuery surfaces only
 * "Thinking..." (implicit, from the POST returning a messageId) and
 * the final terminal state.
 */

export interface MessageTransitionEvent {
  type: "message_transition";
  messageId: string;
  status: "complete" | "stopped" | "error";
  content: string;
}

export type SSEEvent = MessageTransitionEvent;
