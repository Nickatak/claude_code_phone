/**
 * SSE event types pushed to connected clients.
 *
 * Tool events stream as they happen, each tagged with the assistant
 * message they belong to. The assistant message itself emits exactly
 * one terminal event - message_transition - whose `status` field
 * encodes whether it completed, was stopped, or errored.
 */

export interface ToolStartEvent {
  type: "tool_start";
  messageId: string;
  toolName: string;
  toolId: string;
}

export interface ToolCompleteEvent {
  type: "tool_complete";
  messageId: string;
  toolId: string;
  input: string;
}

export interface MessageTransitionEvent {
  type: "message_transition";
  messageId: string;
  status: "complete" | "stopped" | "error";
  content: string;
}

export type SSEEvent =
  | ToolStartEvent
  | ToolCompleteEvent
  | MessageTransitionEvent;
