/**
 * SSE event types pushed to connected clients.
 *
 * These define the protocol between the server and the mobile frontend.
 * Tool events stream in real time, the final response arrives as one
 * complete message, and errors/stops are signaled immediately.
 */

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
