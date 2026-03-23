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
const WORKER_TOKEN = process.env.AUTH_TOKEN; // Worker still uses env token for now

// Session tokens: map of session token -> { deviceId, role, expiry }
interface SessionData {
  deviceId: string;
  role: "admin" | "chat";
  expiry: number;
}
const activeSessions = new Map<string, SessionData>();
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function createSession(deviceId: string, role: "admin" | "chat"): string {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  activeSessions.set(sessionToken, { deviceId, role, expiry: Date.now() + SESSION_MAX_AGE_MS });
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

// --- State ---

let workerSocket: WebSocket | null = null;
let workerDirectories: { path: string; name: string; hasClaudeMd: boolean }[] = [];
const clientSockets = new Set<WebSocket>();

// --- Express app ---

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Login endpoint
app.post("/api/login", (req, res) => {
  const { token } = req.body;
  const db = getDb();
  const device = db.select().from(devices).where(eq(devices.token, token)).get();

  if (!device || device.type !== "client") {
    res.status(401).json({ error: "invalid token" });
    return;
  }

  // Update last seen
  db.update(devices).set({ lastSeen: new Date().toISOString() }).where(eq(devices.id, device.id)).run();

  const sessionToken = createSession(device.id, device.role as "admin" | "chat");
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

// Auth middleware for REST endpoints
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

// Serve login page for unauthenticated users, app for authenticated
app.get("/", (req, res, next) => {
  if (getSession(req.cookies?.rc_session)) {
    next(); // fall through to static file serving
  } else {
    res.sendFile(path.join(__dirname, "..", "public", "login.html"));
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

// --- REST endpoints ---

app.get("/api/status", requireAuth, (_req, res) => {
  res.json({ workerOnline: workerSocket !== null });
});

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

app.get("/api/conversations/:id/messages", requireAuth, (req, res) => {
  const db = getDb();
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rows = db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt).all();
  res.json(rows);
});

// --- HTTP server ---

const server = http.createServer(app);

// --- WebSocket servers ---

const workerWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/ws/worker") {
    workerWss.handleUpgrade(req, socket, head, (ws) => {
      workerWss.emit("connection", ws, req);
    });
  } else if (url.pathname === "/ws/client") {
    // Parse cookies from the upgrade request
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

// --- Worker connection handling ---

workerWss.on("connection", (ws) => {
  let authenticated = false;

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

    // First message must be auth
    if (!authenticated) {
      const workerDevice = (() => {
        if (msg.type !== "auth") return null;
        const db = getDb();
        return db.select().from(devices).where(eq(devices.token, (msg as WorkerAuth).token)).get();
      })();
      if (workerDevice && workerDevice.type === "worker") {
        authenticated = true;
        clearTimeout(authTimeout);

        // Only one worker at a time
        if (workerSocket) {
          workerSocket.close(4002, "replaced by new worker");
        }
        workerSocket = ws;
        workerDirectories = [];
        console.log("Worker connected");
        broadcastToClients({ type: "status", workerOnline: true });
      } else {
        ws.close(4003, "bad auth");
      }
      return;
    }

    // Directory list from worker
    if (msg.type === "directories") {
      workerDirectories = (msg as any).dirs;
      console.log(`Worker reported ${workerDirectories.length} project directories`);
      broadcastToClients({ type: "status", workerOnline: true, directories: workerDirectories });
      return;
    }

    // Authenticated worker messages
    if (msg.type === "stream_event" || msg.type === "result" || msg.type === "error") {
      // Store completed responses
      if (msg.type === "result") {
        const db = getDb();
        db.insert(messages).values({
          id: uuid(),
          conversationId: msg.conversationId,
          role: "assistant",
          content: msg.fullText,
          toolUse: msg.toolUse ? JSON.stringify(msg.toolUse) : null,
        }).run();

        db.update(conversations)
          .set({ sessionId: msg.sessionId, updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, msg.conversationId))
          .run();
      }

      // Forward to all connected clients
      broadcastToClients(msg);
    }
  });

  ws.on("close", () => {
    if (workerSocket === ws) {
      workerSocket = null;
      console.log("Worker disconnected");
      broadcastToClients({ type: "status", workerOnline: false });
    }
    clearTimeout(authTimeout);
  });

  ws.on("error", (err) => {
    console.error("Worker socket error:", err.message);
  });
});

// --- Client connection handling ---

clientWss.on("connection", (ws) => {
  clientSockets.add(ws);

  // Send current status on connect
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

      // New conversation
      if (!conversationId) {
        conversationId = uuid();
        db.insert(conversations).values({
          id: conversationId,
          deviceId: clientSession.deviceId,
          title: msg.message.slice(0, 100),
          cwd: cwd || null,
        }).run();
      } else {
        // Resuming — look up session ID and cwd
        const conv = db.select({
          sessionId: conversations.sessionId,
          cwd: conversations.cwd,
        }).from(conversations).where(eq(conversations.id, conversationId)).get();
        sessionId = conv?.sessionId || undefined;
        cwd = conv?.cwd || cwd;
      }

      // Store user message
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

      // Forward to worker
      const prompt: WorkerPrompt = {
        type: "prompt",
        conversationId,
        message: msg.message,
        cwd,
        role: clientSession.role,
        sessionId,
      };
      workerSocket.send(JSON.stringify(prompt));

      // Tell client which conversation this is (for new conversations)
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

// --- Helpers ---

function broadcastToClients(msg: object) {
  const payload = JSON.stringify(msg);
  for (const client of clientSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// --- Start ---

server.listen(PORT, "0.0.0.0", () => {
  getDb(); // init db on startup
  console.log(`Relay server listening on 0.0.0.0:${PORT}`);
});
