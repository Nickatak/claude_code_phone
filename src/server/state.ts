import { WebSocket } from "ws";
import type { SessionData } from "./sessions";

/**
 * Shared mutable state for the relay server.
 *
 * Because this project uses CommonJS, `import { x }` destructures a snapshot —
 * mutations to `x` in this module won't be visible to importers. All mutable
 * state is accessed via getter/setter functions to ensure a single source of truth.
 */

/** The single active worker connection (only one worker at a time) */
let _workerSocket: WebSocket | null = null;
export function getWorkerSocket() { return _workerSocket; }
export function setWorkerSocket(ws: WebSocket | null) { _workerSocket = ws; }

/** Project directories reported by the worker on connect (shown in admin's project picker) */
let _workerDirectories: { path: string; name: string; hasClaudeMd: boolean }[] = [];
export function getWorkerDirectories() { return _workerDirectories; }
export function setWorkerDirectories(dirs: typeof _workerDirectories) { _workerDirectories = dirs; }

/** All connected client WebSockets (phones/browsers) */
export const clientSockets = new Set<WebSocket>();

/** Heartbeat tracking — if the worker stops sending heartbeats, mark it unresponsive */
let _lastHeartbeat: number = 0;
export function getLastHeartbeat() { return _lastHeartbeat; }
export function setLastHeartbeat(ts: number) { _lastHeartbeat = ts; }

let _workerResponsive: boolean = false;
export function getWorkerResponsive() { return _workerResponsive; }
export function setWorkerResponsive(v: boolean) { _workerResponsive = v; }

export const HEARTBEAT_STALE_MS = 90 * 1000; // 90 seconds without heartbeat = unresponsive

let _heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
export function getHeartbeatCheckInterval() { return _heartbeatCheckInterval; }
export function setHeartbeatCheckInterval(v: ReturnType<typeof setInterval> | null) { _heartbeatCheckInterval = v; }

/**
 * Send a message to connected clients.
 * If deviceId is provided, only sends to clients authenticated as that device
 * (used for conversation events — tenant isolation).
 * If deviceId is omitted, broadcasts to all clients (used for status updates).
 */
export function broadcastToClients(msg: object, deviceId?: string) {
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
