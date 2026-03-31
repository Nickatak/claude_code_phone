import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { conversations, messages, devices } from "../schema";
import { createSession, getSession, activeSessions, SESSION_MAX_AGE_MS } from "./sessions";
import type { SessionData } from "./sessions";
import { getWorkerSocket, getWorkerResponsive } from "./state";

export const app = express();
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
export function requireAuth(
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
    res.sendFile(path.join(__dirname, "..", "..", "public", "login.html"));
  }
});

app.use(express.static(path.join(__dirname, "..", "..", "public")));

// --- REST API ---

app.get("/api/status", requireAuth, (_req, res) => {
  res.json({ workerOnline: getWorkerSocket() !== null && getWorkerResponsive() });
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
