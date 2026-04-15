import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  WorkerPrompt,
  WorkerEvent,
  WorkerResult,
  WorkerError,
  ToolUseRecord,
} from "../types";
import { mapSdkEvent } from "./event-mapper";

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_THRESHOLD = 0.5;

let _rateLimitLocked = false;
let _lastUtilization = 0;

export function getRateLimitLocked() { return _rateLimitLocked; }
export function getLastUtilization() { return _lastUtilization; }

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Prompt timed out after ${ms / 1000 / 60} minutes`);
    this.name = "TimeoutError";
  }
}

export async function handlePrompt(ws: WebSocket, msg: WorkerPrompt, workerCwd: string) {
  const { conversationId, message, cwd, role, sandbox, sessionId } = msg;
  const toolUseRecords: ToolUseRecord[] = [];
  const activeTools: Map<string, { name: string; input: string }> = new Map();
  let fullText = "";
  const isAdmin = role === "admin";

  // Create sandbox directory if it doesn't exist yet
  if (!isAdmin && sandbox) {
    fs.mkdirSync(sandbox, { recursive: true });
  }

  // Timeout — kills the prompt if it runs too long
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(PROMPT_TIMEOUT_MS)), PROMPT_TIMEOUT_MS);
  });

  try {
    // SDK options differ by role
    const options: Record<string, unknown> = isAdmin
      ? {
          cwd: cwd || workerCwd,
          allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
          permissionMode: "bypassPermissions",
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project", "user"],
          includePartialMessages: true,
        }
      : {
          cwd: sandbox || undefined,
          allowedTools: ["Read", "Edit", "Write", "WebSearch", "WebFetch"],
          disallowedTools: ["Bash", "Glob", "Grep", "Agent", "TodoWrite", "NotebookEdit", "ToolSearch"],
          permissionMode: "bypassPermissions",
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: sandbox ? ["project"] : [],
          includePartialMessages: true,
          maxTurns: 5,
          canUseTool: sandbox
            ? (toolName: string, input: any) => {
                const fileTools = ["Read", "Edit", "Write"];
                if (fileTools.includes(toolName)) {
                  const filePath = input?.file_path || input?.path || "";
                  const resolved = path.isAbsolute(filePath)
                    ? path.normalize(filePath)
                    : path.normalize(path.join(sandbox, filePath));
                  if (!resolved.startsWith(path.normalize(sandbox))) {
                    console.log(`SANDBOX DENIED: ${toolName} ${filePath} -> ${resolved}`);
                    return Promise.resolve({
                      behavior: "deny",
                      message: `File access is restricted to your personal directory.`,
                    });
                  }
                }
                return Promise.resolve({ behavior: "allow" });
              }
            : undefined,
        };

    if (sessionId) {
      options.resume = sessionId;
    }

    const session = query({ prompt: message, options });

    // Process the SDK's async event stream, racing against the timeout
    const iterator = session[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);

      if (next.done) break;
      const event = next.value;

      if (ws.readyState !== WebSocket.OPEN) {
        console.log("Relay disconnected during prompt execution");
        return;
      }

      // Rate limit monitoring
      if (event.type === "rate_limit_event") {
        const rle = event as any;
        if (rle.utilization !== undefined) {
          _lastUtilization = rle.utilization;
          console.log(`Rate limit utilization: ${Math.round(rle.utilization * 100)}%`);
          if (rle.utilization >= RATE_LIMIT_THRESHOLD) {
            _rateLimitLocked = true;
            console.log(`LOCKED: utilization hit ${Math.round(rle.utilization * 100)}% (threshold: ${Math.round(RATE_LIMIT_THRESHOLD * 100)}%)`);
          }
        }
      }

      // Stream events — map and forward
      if (event.type === "stream_event") {
        const sdkEvent = (event as any).event;
        const streamEvent = mapSdkEvent(sdkEvent, activeTools);
        if (streamEvent) {
          if (streamEvent.type === "text_delta") {
            fullText += streamEvent.text;
          }
          const outbound: WorkerEvent = {
            type: "stream_event",
            conversationId,
            event: streamEvent,
          };
          ws.send(JSON.stringify(outbound));
        }
      } else if (event.type === "result") {
        const resultEvent = event as any;

        for (const [, tool] of activeTools) {
          toolUseRecords.push({ toolName: tool.name, input: tool.input, result: "" });
        }

        const result: WorkerResult = {
          type: "result",
          conversationId,
          sessionId: resultEvent.session_id || sessionId || "",
          fullText,
          toolUse: toolUseRecords.length > 0 ? toolUseRecords : undefined,
        };
        ws.send(JSON.stringify(result));
        console.log(`Completed prompt for conversation ${conversationId}`);
      }
    }
  } catch (err) {
    const isTimeout = err instanceof TimeoutError;
    const errorMessage = isTimeout
      ? `${err.message}. The worker has moved on to the next queued prompt.`
      : err instanceof Error ? err.message : String(err);

    if (ws.readyState === WebSocket.OPEN) {
      const error: WorkerError = {
        type: "error",
        conversationId,
        message: errorMessage,
      };
      ws.send(JSON.stringify(error));
    }
    console.error(`${isTimeout ? "TIMEOUT" : "Error"} handling prompt for ${conversationId}:`, err);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
