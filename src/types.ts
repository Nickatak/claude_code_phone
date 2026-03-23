// === Worker ↔ Relay protocol ===

/** Worker sends this on connect to authenticate */
export interface WorkerAuth {
  type: "auth";
  token: string;
}

/** Relay sends a prompt to the worker */
export interface WorkerPrompt {
  type: "prompt";
  conversationId: string;
  message: string;
  cwd: string;
  role: "admin" | "chat";
  sandbox?: string;
  sessionId?: string; // set when resuming a conversation
}

/** Worker streams these back to relay */
export interface WorkerEvent {
  type: "stream_event";
  conversationId: string;
  event: StreamEvent;
}

/** Worker sends this when the response is complete */
export interface WorkerResult {
  type: "result";
  conversationId: string;
  sessionId: string;
  fullText: string;
  toolUse?: ToolUseRecord[];
}

export interface WorkerError {
  type: "error";
  conversationId: string;
  message: string;
}

/** Worker sends available project directories after auth */
export interface WorkerDirectories {
  type: "directories";
  dirs: { path: string; name: string; hasClaudeMd: boolean }[];
}

export type WorkerInbound = WorkerPrompt;
export type WorkerOutbound = WorkerAuth | WorkerDirectories | WorkerEvent | WorkerResult | WorkerError;

// === Stream events (subset of what the SDK emits, relevant for the UI) ===

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface ToolStart {
  type: "tool_start";
  toolName: string;
  toolId: string;
}

export interface ToolInput {
  type: "tool_input";
  toolId: string;
  partialInput: string;
}

export interface ToolResult {
  type: "tool_result";
  toolId: string;
  result: string;
}

export type StreamEvent = TextDelta | ToolStart | ToolInput | ToolResult;

// === Client (phone) ↔ Relay protocol ===

/** Phone sends a new message */
export interface ClientSend {
  type: "send";
  conversationId?: string; // omit to start a new conversation
  message: string;
  cwd?: string; // set when starting a new conversation
}

/** Relay pushes these to the phone */
export interface ClientStreamEvent {
  type: "stream_event";
  conversationId: string;
  event: StreamEvent;
}

export interface ClientResult {
  type: "result";
  conversationId: string;
  fullText: string;
  toolUse?: ToolUseRecord[];
}

export interface ClientError {
  type: "error";
  conversationId: string;
  message: string;
}

export interface ClientStatus {
  type: "status";
  workerOnline: boolean;
  directories?: { path: string; name: string; hasClaudeMd: boolean }[];
}

export type ClientInbound = ClientSend;
export type ClientOutbound = ClientStreamEvent | ClientResult | ClientError | ClientStatus;

// === Shared ===

export interface ToolUseRecord {
  toolName: string;
  input: string;
  result: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  sessionId: string | null;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolUse: string | null;
  createdAt: string;
}
