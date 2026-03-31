import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, messages, devices } from "../schema";
import type { WorkerAuth, WorkerOutbound } from "../types";
import {
  getWorkerSocket, setWorkerSocket,
  getWorkerDirectories, setWorkerDirectories,
  getLastHeartbeat, setLastHeartbeat,
  getWorkerResponsive, setWorkerResponsive,
  getHeartbeatCheckInterval, setHeartbeatCheckInterval,
  HEARTBEAT_STALE_MS,
} from "./state";
import { broadcastToClients } from "./broadcast";

export function setupWorkerWs(wss: WebSocketServer) {
  wss.on("connection", (ws) => {
    let authenticated = false;

    // Worker must authenticate within 5 seconds or get kicked
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.close(4001, "auth timeout");
      }
    }, 5000);

    ws.on("message", (data) => {
      let msg: WorkerOutbound;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // First message must be auth — looked up against devices table (type=worker)
      if (!authenticated) {
        const workerDevice = (() => {
          if (msg.type !== "auth") return null;
          const db = getDb();
          return db.select().from(devices).where(eq(devices.token, (msg as WorkerAuth).token)).get();
        })();
        if (workerDevice && workerDevice.type === "worker") {
          authenticated = true;
          clearTimeout(authTimeout);

          // Only one worker at a time — new connections replace old ones
          const existing = getWorkerSocket();
          if (existing) {
            existing.close(4002, "replaced by new worker");
          }
          setWorkerSocket(ws);
          setWorkerDirectories([]);
          setLastHeartbeat(Date.now());
          setWorkerResponsive(true);
          console.log("Worker connected");
          broadcastToClients({ type: "status", workerOnline: true });

          // Start checking for stale heartbeats
          const existingInterval = getHeartbeatCheckInterval();
          if (existingInterval) clearInterval(existingInterval);
          setHeartbeatCheckInterval(setInterval(() => {
            if (!getWorkerSocket()) return;
            const stale = Date.now() - getLastHeartbeat() > HEARTBEAT_STALE_MS;
            if (stale && getWorkerResponsive()) {
              setWorkerResponsive(false);
              console.log(`Worker heartbeat stale (last: ${Math.round((Date.now() - getLastHeartbeat()) / 1000)}s ago) — marking unresponsive`);
              broadcastToClients({ type: "status", workerOnline: false });
            } else if (!stale && !getWorkerResponsive()) {
              setWorkerResponsive(true);
              console.log("Worker heartbeat resumed — marking responsive");
              broadcastToClients({ type: "status", workerOnline: true, directories: getWorkerDirectories() });
            }
          }, 30_000));
        } else {
          ws.close(4003, "bad auth");
        }
        return;
      }

      // Worker sends its list of project directories right after auth
      if (msg.type === "directories") {
        setWorkerDirectories((msg as any).dirs);
        console.log(`Worker reported ${getWorkerDirectories().length} project directories`);
        broadcastToClients({ type: "status", workerOnline: true, directories: getWorkerDirectories() });
        return;
      }

      // Heartbeat — update timestamp (the interval check handles responsive/unresponsive transitions)
      if (msg.type === "heartbeat") {
        setLastHeartbeat(Date.now());
        return;
      }

      // Stream events, results, and errors from Claude — store and forward
      if (msg.type === "stream_event" || msg.type === "result" || msg.type === "error") {
        const db = getDb();

        // On completion, persist the assistant's response to the DB
        if (msg.type === "result") {
          db.insert(messages).values({
            id: uuid(),
            conversationId: msg.conversationId,
            role: "assistant",
            content: msg.fullText,
            toolUse: msg.toolUse ? JSON.stringify(msg.toolUse) : null,
          }).run();

          // Store the SDK session ID so this conversation can be resumed later
          db.update(conversations)
            .set({ sessionId: msg.sessionId, updatedAt: new Date().toISOString() })
            .where(eq(conversations.id, msg.conversationId))
            .run();
        }

        // Forward to the owning device's clients only (tenant isolation)
        const convId = (msg as any).conversationId;
        const conv = convId
          ? db.select({ deviceId: conversations.deviceId })
              .from(conversations)
              .where(eq(conversations.id, convId))
              .get()
          : undefined;
        broadcastToClients(msg, conv?.deviceId || undefined);
      }
    });

    ws.on("close", () => {
      if (getWorkerSocket() === ws) {
        setWorkerSocket(null);
        setWorkerResponsive(false);
        const interval = getHeartbeatCheckInterval();
        if (interval) {
          clearInterval(interval);
          setHeartbeatCheckInterval(null);
        }
        console.log("Worker disconnected");
        broadcastToClients({ type: "status", workerOnline: false });
      }
      clearTimeout(authTimeout);
    });

    ws.on("error", (err) => {
      console.error("Worker socket error:", err.message);
    });
  });
}
