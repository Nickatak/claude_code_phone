/**
 * Shared types for the v2 protocol.
 *
 * Unlike v1's relay protocol (worker <-> relay <-> client), v2 has a
 * single server. These types define the SSE events pushed to clients
 * and the internal structures used by the SDK process manager.
 */

// SSE events pushed to connected clients
export interface ToolStartEvent {
  type: "tool_start";
  toolName: string;
  toolId: string;
}

export interface ToolCompleteEvent {
  type: "tool_complete";
  toolId: string;
  input: string;
}

export interface ResponseCompleteEvent {
  type: "response_complete";
  messageId: string;
  content: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export interface StoppedEvent {
  type: "stopped";
}

export type SSEEvent =
  | ToolStartEvent
  | ToolCompleteEvent
  | ResponseCompleteEvent
  | ErrorEvent
  | StoppedEvent;

// Internal tracking for active SDK processes
export interface ActiveProcess {
  conversationId: string;
  messageId: string;
  abort: () => void;
}
