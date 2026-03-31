import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, messages } from "../schema";
import type { WorkerPrompt, ClientInbound, ClientStatus } from "../types";
import type { SessionData } from "./sessions";
import { getWorkerSocket, getWorkerDirectories, clientSockets } from "./state";

export function setupClientWs(wss: WebSocketServer) {
  wss.on("connection", (ws) => {
    clientSockets.add(ws);

    // Immediately tell the client whether the worker is online
    const dirs = getWorkerDirectories();
    const statusMsg: ClientStatus = {
      type: "status",
      workerOnline: getWorkerSocket() !== null,
      directories: dirs.length > 0 ? dirs : undefined,
    };
    ws.send(JSON.stringify(statusMsg));

    ws.on("message", (data) => {
      console.log("Client message received:", data.toString().slice(0, 200));
      let msg: ClientInbound;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "send") {
        const worker = getWorkerSocket();
        console.log("Forwarding to worker, conversationId:", msg.conversationId || "new");
        if (!worker || worker.readyState !== WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              conversationId: msg.conversationId || "",
              message: "Worker is offline",
            })
          );
          return;
        }

        const db = getDb();
        const clientSession = (ws as any).session as SessionData;
        let conversationId = msg.conversationId;
        let sessionId: string | undefined;
        let cwd: string = msg.cwd || "";

        if (!conversationId) {
          // New conversation — create it in the DB, tied to this device
          conversationId = uuid();
          db.insert(conversations).values({
            id: conversationId,
            deviceId: clientSession.deviceId,
            title: msg.message.slice(0, 100),
            cwd: cwd || null,
          }).run();
        } else {
          // Resuming — pull the SDK session ID and cwd from the DB
          const conv = db.select({
            sessionId: conversations.sessionId,
            cwd: conversations.cwd,
          }).from(conversations).where(eq(conversations.id, conversationId)).get();
          sessionId = conv?.sessionId || undefined;
          cwd = conv?.cwd || cwd;
        }

        // Store the user's message
        db.insert(messages).values({
          id: uuid(),
          conversationId,
          role: "user",
          content: msg.message,
        }).run();

        db.update(conversations)
          .set({ updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, conversationId))
          .run();

        // Build the prompt and forward to the worker
        const prompt: WorkerPrompt = {
          type: "prompt",
          conversationId,
          message: msg.message,
          cwd,
          role: clientSession.role,
          sandbox: clientSession.sandbox,
          sessionId,
        };
        worker.send(JSON.stringify(prompt));

        // Tell the client which conversation ID was assigned (for new conversations)
        if (!msg.conversationId) {
          ws.send(
            JSON.stringify({
              type: "conversation_created",
              conversationId,
            })
          );
        }
      }
    });

    ws.on("close", () => {
      clientSockets.delete(ws);
    });

    ws.on("error", (err) => {
      console.error("Client socket error:", err.message);
    });
  });
}
