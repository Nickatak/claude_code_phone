/**
 * Protocol types for the three-tier relay system.
 *
 * Message flow:
 *   Phone (Client) ←WebSocket→ Relay (Pixel) ←WebSocket→ Worker (PC)
 *
 * Two separate WebSocket protocols:
 *   1. Worker ↔ Relay: Worker authenticates, receives prompts, streams responses
 *   2. Client ↔ Relay: Phone sends messages, receives streaming events and status
 *
 * The relay is a dumb pipe — it stores messages and forwards events,
 * but never interprets or modifies the content.
 */

// ============================================================
// Worker ↔ Relay protocol
// These messages flow between the PC (worker) and the Pixel (relay)
// ============================================================

/** First message the worker sends after connecting. Looked up against the devices table. */
export interface WorkerAuth {
  type: "auth";
  token: string;
}

/**
 * Relay sends this to the worker when a user submits a message.
 * The worker uses these fields to configure the Claude Code SDK session.
 */
export interface WorkerPrompt {
  type: "prompt";
  conversationId: string;
  message: string;
  /** Working directory for this conversation (project dir for admin, sandbox for chat) */
  cwd: string;
  /** Determines tool access: admin = full Claude Code, chat = sandboxed */
  role: "admin" | "chat";
  /** Filesystem path to the chat user's sandboxed directory (chat role only) */
  sandbox?: string;
  /** SDK session ID for resuming a previous conversation after worker restart */
  sessionId?: string;
}

/** Worker streams these back as Claude generates a response. One per SDK stream event. */
export interface WorkerEvent {
  type: "stream_event";
  conversationId: string;
  event: StreamEvent;
}

/** Worker sends this when Claude's response is fully complete.
 *  Contains the full text and session ID for future resume. */
export interface WorkerResult {
  type: "result";
  conversationId: string;
  /** SDK session ID — stored in the DB so the conversation can be resumed later */
  sessionId: string;
  /** Complete response text (in case streaming was incomplete) */
  fullText: string;
  toolUse?: ToolUseRecord[];
}

/** Worker sends this if the SDK throws an error during execution */
export interface WorkerError {
  type: "error";
  conversationId: string;
  message: string;
}

/**
 * Worker sends this immediately after auth — a list of project directories
 * found on the PC. The relay forwards it to clients so admin users
 * can pick a working directory when starting a new conversation.
 */
export interface WorkerDirectories {
  type: "directories";
  dirs: { path: string; name: string; hasClaudeMd: boolean }[];
}

/** Messages the worker receives from the relay */
export type WorkerInbound = WorkerPrompt;
/** Messages the worker sends to the relay */
export type WorkerOutbound = WorkerAuth | WorkerDirectories | WorkerEvent | WorkerResult | WorkerError;

// ============================================================
// Stream events
// Simplified subset of SDK events that the UI needs to render
// ============================================================

/** A chunk of text from Claude's response, delivered incrementally */
export interface TextDelta {
  type: "text_delta";
  text: string;
}

/** Claude is starting to use a tool (Bash, Read, WebSearch, etc.) */
export interface ToolStart {
  type: "tool_start";
  toolName: string;
  toolId: string;
}

/** Partial JSON input for a tool call, streamed incrementally */
export interface ToolInput {
  type: "tool_input";
  toolId: string;
  partialInput: string;
}

/** A tool call has completed */
export interface ToolResult {
  type: "tool_result";
  toolId: string;
  result: string;
}

export type StreamEvent = TextDelta | ToolStart | ToolInput | ToolResult;

// ============================================================
// Client (phone) ↔ Relay protocol
// These messages flow between the phone browser and the Pixel (relay)
// ============================================================

/** User sends a chat message from the phone UI */
export interface ClientSend {
  type: "send";
  /** Omit to start a new conversation */
  conversationId?: string;
  message: string;
  /** Working directory — only set when starting a new conversation (admin only) */
  cwd?: string;
}

/** Relay forwards a stream event from the worker to the phone */
export interface ClientStreamEvent {
  type: "stream_event";
  conversationId: string;
  event: StreamEvent;
}

/** Relay forwards the completed response to the phone */
export interface ClientResult {
  type: "result";
  conversationId: string;
  fullText: string;
  toolUse?: ToolUseRecord[];
}

/** An error occurred (worker offline, SDK failure, etc.) */
export interface ClientError {
  type: "error";
  conversationId: string;
  message: string;
}

/** Sent to the phone on connect and whenever worker status changes */
export interface ClientStatus {
  type: "status";
  workerOnline: boolean;
  /** Available project directories from the worker (admin users see these in the picker) */
  directories?: { path: string; name: string; hasClaudeMd: boolean }[];
}

/** Messages the relay receives from the phone */
export type ClientInbound = ClientSend;
/** Messages the relay sends to the phone */
export type ClientOutbound = ClientStreamEvent | ClientResult | ClientError | ClientStatus;

// ============================================================
// Shared types
// ============================================================

/** Record of a single tool invocation, stored in the messages table */
export interface ToolUseRecord {
  toolName: string;
  input: string;
  result: string;
}
