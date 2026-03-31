import "./env";
import WebSocket from "ws";
import type {
  WorkerAuth,
  WorkerDirectories,
  WorkerHeartbeat,
  WorkerPrompt,
  WorkerError,
} from "./types";
import { handlePrompt, getRateLimitLocked, getLastUtilization } from "./worker/prompt-handler";
import { scanProjectDirs } from "./worker/project-scanner";

const RELAY_URL = process.env.RELAY_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const WORKER_CWD = process.env.WORKER_CWD || process.cwd();

if (!RELAY_URL || !AUTH_TOKEN) {
  console.error("RELAY_URL and AUTH_TOKEN environment variables are required");
  process.exit(1);
}

const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

// --- Prompt queue ---

const promptQueue: WorkerPrompt[] = [];
let activePrompt: WorkerPrompt | null = null;

function enqueuePrompt(ws: WebSocket, msg: WorkerPrompt) {
  promptQueue.push(msg);
  console.log(`Queued prompt for ${msg.conversationId} (queue depth: ${promptQueue.length})`);
  processQueue(ws);
}

function processQueue(ws: WebSocket) {
  if (activePrompt) return;
  const next = promptQueue.shift();
  if (!next) return;

  activePrompt = next;
  console.log(`Processing prompt for ${next.conversationId} (${promptQueue.length} remaining in queue)`);

  handlePrompt(ws, next, WORKER_CWD).finally(() => {
    activePrompt = null;
    processQueue(ws);
  });
}

// --- WebSocket connection ---

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function connect() {
  const wsUrl = RELAY_URL!.replace(/^http/, "ws") + "/ws/worker";
  console.log(`Connecting to relay at ${wsUrl}...`);
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("Connected to relay, authenticating...");
    const auth: WorkerAuth = { type: "auth", token: AUTH_TOKEN! };
    ws.send(JSON.stringify(auth));

    const dirs = scanProjectDirs(WORKER_CWD);
    const dirMsg: WorkerDirectories = { type: "directories", dirs };
    ws.send(JSON.stringify(dirMsg));
    console.log(`Worker registered and ready (${dirs.length} project dirs)`);

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const hb: WorkerHeartbeat = {
          type: "heartbeat",
          queueDepth: promptQueue.length + (activePrompt ? 1 : 0),
          activeConversationId: activePrompt?.conversationId,
        };
        ws.send(JSON.stringify(hb));
      }
    }, HEARTBEAT_INTERVAL_MS);
  });

  ws.on("message", (data) => {
    let msg: WorkerPrompt;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type !== "prompt") return;

    if (getRateLimitLocked()) {
      const err: WorkerError = {
        type: "error",
        conversationId: msg.conversationId,
        message: `Rate limit protection: worker locked at ${Math.round(getLastUtilization() * 100)}% utilization. Restart worker to unlock.`,
      };
      ws.send(JSON.stringify(err));
      return;
    }

    console.log(`Received prompt for conversation ${msg.conversationId}`);
    enqueuePrompt(ws, msg);
  });

  ws.on("close", (code, reason) => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    promptQueue.length = 0;
    activePrompt = null;
    console.log(`Disconnected from relay (${code}: ${reason}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

connect();
