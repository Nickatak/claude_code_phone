/**
 * Worker — runs on Nick's main PC (WSL).
 *
 * This is where Claude Code actually executes. The worker:
 *   1. Connects to the relay (Pixel) via WebSocket
 *   2. Authenticates with its device token
 *   3. Sends a list of available project directories
 *   4. Waits for prompts from the relay
 *   5. Runs the Claude Code SDK for each prompt
 *   6. Streams events (text, tool calls) back to the relay
 *
 * The worker handles two roles differently:
 *   - admin: Full Claude Code — all tools, bypass permissions, project cwd
 *   - chat: Sandboxed — only Read/Edit/Write within their sandbox dir + WebSearch/WebFetch
 *
 * Auto-reconnects if the relay goes down. Locks itself if rate limit
 * utilization exceeds 50% (protection against unauthorized usage while sleeping).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  WorkerAuth,
  WorkerDirectories,
  WorkerPrompt,
  WorkerEvent,
  WorkerResult,
  WorkerError,
  StreamEvent,
  ToolUseRecord,
} from "./types";

const RELAY_URL = process.env.RELAY_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
/** Base directory for scanning project folders (admin's project picker) */
const WORKER_CWD = process.env.WORKER_CWD || process.cwd();

if (!RELAY_URL || !AUTH_TOKEN) {
  console.error("RELAY_URL and AUTH_TOKEN environment variables are required");
  process.exit(1);
}

const RECONNECT_DELAY_MS = 5000;

/**
 * Rate limit kill switch.
 * If the SDK reports utilization above this threshold, the worker locks itself
 * and refuses all new prompts. Only a restart unlocks it.
 * This prevents an attacker from burning through the Max subscription
 * rate limit while Nick is asleep.
 */
const RATE_LIMIT_THRESHOLD = 0.5;
let rateLimitLocked = false;
let lastUtilization = 0;

// ============================================================
// WebSocket connection to the relay
// ============================================================

function connect() {
  const wsUrl = RELAY_URL!.replace(/^http/, "ws") + "/ws/worker";
  console.log(`Connecting to relay at ${wsUrl}...`);
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("Connected to relay, authenticating...");
    const auth: WorkerAuth = { type: "auth", token: AUTH_TOKEN! };
    ws.send(JSON.stringify(auth));

    // Tell the relay what project directories are available on this machine
    const dirs = scanProjectDirs(WORKER_CWD);
    const dirMsg: WorkerDirectories = { type: "directories", dirs };
    ws.send(JSON.stringify(dirMsg));
    console.log(`Worker registered and ready (${dirs.length} project dirs)`);
  });

  ws.on("message", async (data) => {
    let msg: WorkerPrompt;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type !== "prompt") return;

    // Refuse all prompts if rate limit protection tripped
    if (rateLimitLocked) {
      const err: WorkerError = {
        type: "error",
        conversationId: msg.conversationId,
        message: `Rate limit protection: worker locked at ${Math.round(lastUtilization * 100)}% utilization. Restart worker to unlock.`,
      };
      ws.send(JSON.stringify(err));
      return;
    }

    console.log(`Received prompt for conversation ${msg.conversationId}`);
    await handlePrompt(ws, msg);
  });

  ws.on("close", (code, reason) => {
    console.log(`Disconnected from relay (${code}: ${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

// ============================================================
// Prompt handling — the core of the worker
// ============================================================

async function handlePrompt(ws: WebSocket, msg: WorkerPrompt) {
  const { conversationId, message, cwd, role, sandbox, sessionId } = msg;
  const toolUseRecords: ToolUseRecord[] = [];
  const activeTools: Map<string, { name: string; input: string }> = new Map();
  let fullText = "";

  const isAdmin = role === "admin";

  // Create sandbox directory if it doesn't exist yet
  if (!isAdmin && sandbox) {
    fs.mkdirSync(sandbox, { recursive: true });
  }

  try {
    /**
     * SDK options differ by role:
     *
     * Admin (Nick):
     *   - Full tool access, bypass all permissions
     *   - Uses the selected project directory as cwd
     *   - Loads CLAUDE.md and user settings (the full harness)
     *
     * Chat (Mom/Brother):
     *   - Only Read/Edit/Write (sandboxed) + WebSearch/WebFetch
     *   - All system tools (Bash, Glob, Grep) explicitly blocked
     *   - cwd set to their sandbox directory
     *   - canUseTool callback enforces filesystem sandbox
     *   - Loads project settings from sandbox (their personal CLAUDE.md)
     *   - Limited to 5 turns (enough for search → fetch → respond)
     */
    const options: Record<string, unknown> = isAdmin ? {
      cwd: cwd || WORKER_CWD,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "user"],
      includePartialMessages: true,
    } : {
      cwd: sandbox || undefined,
      allowedTools: ["Read", "Edit", "Write", "WebSearch", "WebFetch"],
      disallowedTools: ["Bash", "Glob", "Grep", "Agent", "TodoWrite", "NotebookEdit", "ToolSearch"],
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: sandbox ? ["project"] : [],
      includePartialMessages: true,
      maxTurns: 5,
      /**
       * Filesystem sandbox enforcement.
       * Even though cwd is set to the sandbox, Claude can use absolute paths
       * to escape. This callback rejects any file operation targeting a path
       * outside the sandbox directory.
       */
      canUseTool: sandbox ? (toolName: string, input: any) => {
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
      } : undefined,
    };

    // Resume a previous conversation if we have a session ID
    if (sessionId) {
      options.resume = sessionId;
    }

    const session = query({ prompt: message, options });

    // Process the SDK's async event stream
    for await (const event of session) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log("Relay disconnected during prompt execution");
        return;
      }

      // Monitor rate limit utilization — lock if threshold exceeded
      if (event.type === "rate_limit_event") {
        const rle = event as any;
        if (rle.utilization !== undefined) {
          lastUtilization = rle.utilization;
          console.log(`Rate limit utilization: ${Math.round(rle.utilization * 100)}%`);
          if (rle.utilization >= RATE_LIMIT_THRESHOLD) {
            rateLimitLocked = true;
            console.log(`LOCKED: Rate limit utilization hit ${Math.round(rle.utilization * 100)}% (threshold: ${Math.round(RATE_LIMIT_THRESHOLD * 100)}%)`);
          }
        }
      }

      // Stream events — map SDK events to our simplified protocol and forward
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
        // Response complete — send the final result with full text and session ID
        const resultEvent = event as any;

        for (const [, tool] of activeTools) {
          toolUseRecords.push({
            toolName: tool.name,
            input: tool.input,
            result: "",
          });
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
    const error: WorkerError = {
      type: "error",
      conversationId,
      message: err instanceof Error ? err.message : String(err),
    };
    ws.send(JSON.stringify(error));
    console.error(`Error handling prompt for ${conversationId}:`, err);
  }
}

// ============================================================
// SDK event mapping
// The Claude Code SDK emits raw Anthropic API streaming events.
// We translate them into our simplified StreamEvent protocol
// that the frontend knows how to render.
// ============================================================

function mapSdkEvent(
  sdkEvent: any,
  activeTools: Map<string, { name: string; input: string }>
): StreamEvent | null {
  if (!sdkEvent || !sdkEvent.type) return null;

  if (sdkEvent.type === "content_block_delta") {
    // Text chunk from Claude's response
    if (sdkEvent.delta?.type === "text_delta") {
      return { type: "text_delta", text: sdkEvent.delta.text };
    }
    // Partial JSON for a tool call's input (streamed incrementally)
    if (sdkEvent.delta?.type === "input_json_delta") {
      const toolId = String(sdkEvent.index);
      const tool = activeTools.get(toolId);
      if (tool) {
        tool.input += sdkEvent.delta.partial_json;
      }
      return {
        type: "tool_input",
        toolId,
        partialInput: sdkEvent.delta.partial_json,
      };
    }
  }

  // Claude is starting a new tool call
  if (
    sdkEvent.type === "content_block_start" &&
    sdkEvent.content_block?.type === "tool_use"
  ) {
    const toolId = String(sdkEvent.index);
    activeTools.set(toolId, {
      name: sdkEvent.content_block.name,
      input: "",
    });
    return {
      type: "tool_start",
      toolName: sdkEvent.content_block.name,
      toolId,
    };
  }

  // A content block (tool call) has finished
  if (sdkEvent.type === "content_block_stop") {
    const toolId = String(sdkEvent.index);
    const tool = activeTools.get(toolId);
    if (tool) {
      return {
        type: "tool_result",
        toolId,
        result: tool.input,
      };
    }
  }

  return null;
}

// ============================================================
// Project directory scanner
// Scans the worker's base directory for project folders.
// Used to populate the admin's project picker in the UI.
// Projects with CLAUDE.md are sorted first (they're "real" projects).
// ============================================================

function scanProjectDirs(baseDir: string) {
  const dirs: { path: string; name: string; hasClaudeMd: boolean }[] = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const fullPath = path.join(baseDir, entry.name);
      const hasClaudeMd = fs.existsSync(path.join(fullPath, "CLAUDE.md")) ||
        fs.existsSync(path.join(fullPath, ".claude", "settings.json"));
      dirs.push({ path: fullPath, name: entry.name, hasClaudeMd });
    }
  } catch (err) {
    console.error("Error scanning project dirs:", err);
  }
  dirs.sort((a, b) => {
    if (a.hasClaudeMd !== b.hasClaudeMd) return a.hasClaudeMd ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return dirs;
}

// ============================================================
// Start
// ============================================================

connect();
