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
const WORKER_CWD = process.env.WORKER_CWD || process.cwd();

if (!RELAY_URL || !AUTH_TOKEN) {
  console.error("RELAY_URL and AUTH_TOKEN environment variables are required");
  process.exit(1);
}

const RECONNECT_DELAY_MS = 5000;
const RATE_LIMIT_THRESHOLD = 0.5; // Lock at 50% utilization

let rateLimitLocked = false;
let lastUtilization = 0;

function connect() {
  const wsUrl = RELAY_URL!.replace(/^http/, "ws") + "/ws/worker";
  console.log(`Connecting to relay at ${wsUrl}...`);
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("Connected to relay, authenticating...");
    const auth: WorkerAuth = { type: "auth", token: AUTH_TOKEN! };
    ws.send(JSON.stringify(auth));

    // Send available project directories
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

async function handlePrompt(ws: WebSocket, msg: WorkerPrompt) {
  const { conversationId, message, cwd, role, sessionId } = msg;
  const toolUseRecords: ToolUseRecord[] = [];
  const activeTools: Map<string, { name: string; input: string }> = new Map();
  let fullText = "";

  const isAdmin = role === "admin";

  try {
    const options: Record<string, unknown> = {
      cwd: isAdmin ? (cwd || WORKER_CWD) : undefined,
      allowedTools: isAdmin ? ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"] : [],
      permissionMode: isAdmin ? "bypassPermissions" : "plan",
      systemPrompt: isAdmin
        ? { type: "preset", preset: "claude_code" }
        : "You are a helpful assistant. You are in chat-only mode — no tools or file access are available.",
      settingSources: isAdmin ? ["project", "user"] : [],
      includePartialMessages: true,
      maxTurns: isAdmin ? undefined : 1,
    };

    if (sessionId) {
      options.resume = sessionId;
    }

    const session = query({ prompt: message, options });

    for await (const event of session) {
      if (ws.readyState !== WebSocket.OPEN) {
        console.log("Relay disconnected during prompt execution");
        return;
      }

      // Check for rate limit events
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

      if (event.type === "stream_event") {
        const sdkEvent = (event as any).event;
        const streamEvent = mapSdkEvent(sdkEvent, activeTools);
        if (streamEvent) {
          // Accumulate text
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

        // Collect tool use records from active tools
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

function mapSdkEvent(
  sdkEvent: any,
  activeTools: Map<string, { name: string; input: string }>
): StreamEvent | null {
  if (!sdkEvent || !sdkEvent.type) return null;

  if (sdkEvent.type === "content_block_delta") {
    if (sdkEvent.delta?.type === "text_delta") {
      return { type: "text_delta", text: sdkEvent.delta.text };
    }
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

  // Tool results come as assistant messages with tool_result content
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
  // Sort: projects with CLAUDE.md first, then alphabetical
  dirs.sort((a, b) => {
    if (a.hasClaudeMd !== b.hasClaudeMd) return a.hasClaudeMd ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return dirs;
}

// --- Start ---
connect();
