/**
 * Relay Server — runs on the Pixel 3a (always-on box).
 *
 * This is the central hub. It does NOT run Claude or call any AI APIs.
 * It simply:
 *   1. Serves the mobile chat UI (static files)
 *   2. Authenticates devices via token → cookie session
 *   3. Accepts a WebSocket from the worker (PC) for Claude Code execution
 *   4. Accepts WebSocket connections from clients (phones/browsers)
 *   5. Relays messages between clients and the worker
 *   6. Stores conversation history in SQLite
 *
 * Think of it as a mailbox with tenant isolation.
 */

import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { conversations, messages, devices } from "./schema";
import type {
  WorkerAuth,
  WorkerOutbound,
  WorkerPrompt,
  ClientInbound,
  ClientOutbound,
  ClientStatus,
} from "./types";

const PORT = parseInt(process.env.PORT || "3000", 10);

// ============================================================
// Session management
// Sessions are in-memory (lost on relay restart — users just re-login).
// Each session maps a random token (stored as an HTTP-only cookie)
// to the device that authenticated.
// ============================================================

interface SessionData {
  deviceId: string;
  role: "admin" | "chat";
  sandbox?: string;
  expiry: number;
}

const activeSessions = new Map<string, SessionData>();
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(deviceId: string, role: "admin" | "chat", sandbox?: string): string {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  activeSessions.set(sessionToken, { deviceId, role, sandbox, expiry: Date.now() + SESSION_MAX_AGE_MS });
  return sessionToken;
}

function getSession(token: string | undefined): SessionData | null {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiry) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

// ============================================================
// Runtime state
// ============================================================

/** The single active worker connection (only one worker at a time) */
let workerSocket: WebSocket | null = null;
/** Project directories reported by the worker on connect (shown in admin's project picker) */
let workerDirectories: { path: string; name: string; hasClaudeMd: boolean }[] = [];
/** All connected client WebSockets (phones/browsers) */
const clientSockets = new Set<WebSocket>();

/** Heartbeat tracking — if the worker stops sending heartbeats, mark it unresponsive */
let lastHeartbeat: number = 0;
let workerResponsive: boolean = false;
const HEARTBEAT_STALE_MS = 90 * 1000; // 90 seconds without heartbeat = unresponsive
let heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;

// ============================================================
// Express app + auth
// ============================================================

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

/**
 * Login: client POSTs a token, we look it up in the devices table.
 * If valid, set an HTTP-only session cookie (never visible to JS).
 */
app.post("/api/login", (req, res) => {
  const { token } = req.body;
  const db = getDb();
  const device = db.select().from(devices).where(eq(devices.token, token)).get();

  if (!device || device.type !== "client") {
    res.status(401).json({ error: "invalid token" });
    return;
  }

  db.update(devices).set({ lastSeen: new Date().toISOString() }).where(eq(devices.id, device.id)).run();

  const sessionToken = createSession(device.id, device.role as "admin" | "chat", device.sandbox || undefined);
  res.cookie("rc_session", sessionToken, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
  res.json({ ok: true, role: device.role });
});

app.post("/api/logout", (req, res) => {
  const sessionToken = req.cookies?.rc_session;
  if (sessionToken) activeSessions.delete(sessionToken);
  res.clearCookie("rc_session");
  res.json({ ok: true });
});

/** Middleware: rejects unauthenticated requests, attaches session to req */
function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const session = getSession(req.cookies?.rc_session);
  if (session) {
    (req as any).session = session;
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

/** Root route: authenticated users get the chat app, others get the login page */
app.get("/", (req, res, next) => {
  if (getSession(req.cookies?.rc_session)) {
    next();
  } else {
    res.sendFile(path.join(__dirname, "..", "public", "login.html"));
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

// ============================================================
// REST API
// ============================================================

app.get("/api/status", requireAuth, (_req, res) => {
  res.json({ workerOnline: workerSocket !== null && workerResponsive });
});

/** List conversations — scoped to the authenticated device (tenant isolation) */
app.get("/api/conversations", requireAuth, (req, res) => {
  const db = getDb();
  const session = (req as any).session as SessionData;
  const rows = db.select().from(conversations)
    .where(eq(conversations.deviceId, session.deviceId))
    .orderBy(desc(conversations.updatedAt))
    .limit(50)
    .all();
  res.json(rows);
});

/** Get messages for a specific conversation */
app.get("/api/conversations/:id/messages", requireAuth, (req, res) => {
  const db = getDb();
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rows = db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt).all();
  res.json(rows);
});

// ============================================================
// HTTP server + WebSocket upgrade routing
// ============================================================

const server = http.createServer(app);

const workerWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

/**
 * Route WebSocket upgrades to the appropriate handler.
 * /ws/worker — the PC connects here
 * /ws/client — phones/browsers connect here (authenticated via session cookie)
 */
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/ws/worker") {
    workerWss.handleUpgrade(req, socket, head, (ws) => {
      workerWss.emit("connection", ws, req);
    });
  } else if (url.pathname === "/ws/client") {
    const cookieHeader = req.headers.cookie || "";
    const sessionMatch = cookieHeader.match(/rc_session=([^;]+)/);
    const sessionToken = sessionMatch ? sessionMatch[1] : undefined;
    const clientSession = getSession(sessionToken);
    if (!clientSession) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).session = clientSession;
      clientWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ============================================================
// Worker WebSocket handler
// The worker (PC) connects here, authenticates, then receives
// prompts and streams back responses.
// ============================================================

workerWss.on("connection", (ws) => {
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
        if (workerSocket) {
          workerSocket.close(4002, "replaced by new worker");
        }
        workerSocket = ws;
        workerDirectories = [];
        lastHeartbeat = Date.now();
        workerResponsive = true;
        console.log("Worker connected");
        broadcastToClients({ type: "status", workerOnline: true });

        // Start checking for stale heartbeats
        if (heartbeatCheckInterval) clearInterval(heartbeatCheckInterval);
        heartbeatCheckInterval = setInterval(() => {
          if (!workerSocket) return;
          const stale = Date.now() - lastHeartbeat > HEARTBEAT_STALE_MS;
          if (stale && workerResponsive) {
            workerResponsive = false;
            console.log(`Worker heartbeat stale (last: ${Math.round((Date.now() - lastHeartbeat) / 1000)}s ago) — marking unresponsive`);
            broadcastToClients({ type: "status", workerOnline: false });
          } else if (!stale && !workerResponsive) {
            workerResponsive = true;
            console.log("Worker heartbeat resumed — marking responsive");
            broadcastToClients({ type: "status", workerOnline: true, directories: workerDirectories });
          }
        }, 30_000);
      } else {
        ws.close(4003, "bad auth");
      }
      return;
    }

    // Worker sends its list of project directories right after auth
    if (msg.type === "directories") {
      workerDirectories = (msg as any).dirs;
      console.log(`Worker reported ${workerDirectories.length} project directories`);
      broadcastToClients({ type: "status", workerOnline: true, directories: workerDirectories });
      return;
    }

    // Heartbeat — update timestamp (the interval check handles responsive/unresponsive transitions)
    if (msg.type === "heartbeat") {
      lastHeartbeat = Date.now();
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
    if (workerSocket === ws) {
      workerSocket = null;
      workerResponsive = false;
      if (heartbeatCheckInterval) {
        clearInterval(heartbeatCheckInterval);
        heartbeatCheckInterval = null;
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

// ============================================================
// Client WebSocket handler
// Phones/browsers connect here. They send chat messages,
// and receive streaming responses + status updates.
// ============================================================

clientWss.on("connection", (ws) => {
  clientSockets.add(ws);

  // Immediately tell the client whether the worker is online
  const statusMsg: ClientStatus = {
    type: "status",
    workerOnline: workerSocket !== null,
    directories: workerDirectories.length > 0 ? workerDirectories : undefined,
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
      console.log("Forwarding to worker, conversationId:", msg.conversationId || "new");
      if (!workerSocket || workerSocket.readyState !== WebSocket.OPEN) {
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
      workerSocket.send(JSON.stringify(prompt));

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

// ============================================================
// Helpers
// ============================================================

/**
 * Send a message to connected clients.
 * If deviceId is provided, only sends to clients authenticated as that device
 * (used for conversation events — tenant isolation).
 * If deviceId is omitted, broadcasts to all clients (used for status updates).
 */
function broadcastToClients(msg: object, deviceId?: string) {
  const payload = JSON.stringify(msg);
  for (const client of clientSockets) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!deviceId) {
      client.send(payload);
      continue;
    }
    const clientSession = (client as any).session as SessionData | undefined;
    if (clientSession && clientSession.deviceId === deviceId) {
      client.send(payload);
    }
  }
}

// ============================================================
// Start
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  getDb(); // init db + run migrations on startup
  console.log(`Relay server listening on 0.0.0.0:${PORT}`);
});
