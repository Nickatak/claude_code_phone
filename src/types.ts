// ============================================================
// Worker <-> Relay protocol
// ============================================================

export interface WorkerAuth {
  type: "auth";
  token: string;
}

export interface WorkerPrompt {
  type: "prompt";
  conversationId: string;
  message: string;
  cwd: string;
  role: "admin" | "chat";
  sandbox?: string;
  sessionId?: string;
}

export interface WorkerEvent {
  type: "stream_event";
  conversationId: string;
  event: StreamEvent;
}

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

export interface WorkerDirectories {
  type: "directories";
  dirs: { path: string; name: string; hasClaudeMd: boolean }[];
}

export interface WorkerHeartbeat {
  type: "heartbeat";
  queueDepth: number;
  activeConversationId?: string;
}

export type WorkerInbound = WorkerPrompt;
export type WorkerOutbound = WorkerAuth | WorkerDirectories | WorkerEvent | WorkerResult | WorkerError | WorkerHeartbeat;

// ============================================================
// Stream events
// ============================================================

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

// ============================================================
// Client (phone) <-> Relay protocol
// ============================================================

export interface ClientSend {
  type: "send";
  conversationId?: string;
  message: string;
  cwd?: string;
}

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

// ============================================================
// Shared
// ============================================================

export interface ToolUseRecord {
  toolName: string;
  input: string;
  result: string;
}
