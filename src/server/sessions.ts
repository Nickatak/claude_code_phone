import crypto from "crypto";

export interface SessionData {
  deviceId: string;
  role: "admin" | "chat";
  sandbox?: string;
  expiry: number;
}

export const activeSessions = new Map<string, SessionData>();
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createSession(deviceId: string, role: "admin" | "chat", sandbox?: string): string {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  activeSessions.set(sessionToken, { deviceId, role, sandbox, expiry: Date.now() + SESSION_MAX_AGE_MS });
  return sessionToken;
}

export function getSession(token: string | undefined): SessionData | null {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiry) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}
