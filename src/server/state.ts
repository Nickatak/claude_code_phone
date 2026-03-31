import { WebSocket } from "ws";

/**
 * Shared mutable state for the relay server.
 *
 * Because this project uses CommonJS, `import { x }` destructures a snapshot —
 * mutations to `x` in this module won't be visible to importers. All mutable
 * state is accessed via getter/setter functions to ensure a single source of truth.
 */

// --- Worker connection ---

let _workerSocket: WebSocket | null = null;
export function getWorkerSocket() { return _workerSocket; }
export function setWorkerSocket(ws: WebSocket | null) { _workerSocket = ws; }

let _workerDirectories: { path: string; name: string; hasClaudeMd: boolean }[] = [];
export function getWorkerDirectories() { return _workerDirectories; }
export function setWorkerDirectories(dirs: typeof _workerDirectories) { _workerDirectories = dirs; }

// --- Client connections ---

export const clientSockets = new Set<WebSocket>();

// --- Heartbeat tracking ---

let _lastHeartbeat: number = 0;
export function getLastHeartbeat() { return _lastHeartbeat; }
export function setLastHeartbeat(ts: number) { _lastHeartbeat = ts; }

let _workerResponsive: boolean = false;
export function getWorkerResponsive() { return _workerResponsive; }
export function setWorkerResponsive(v: boolean) { _workerResponsive = v; }

export const HEARTBEAT_STALE_MS = 90 * 1000; // 90s without heartbeat = unresponsive

let _heartbeatCheckInterval: ReturnType<typeof setInterval> | null = null;
export function getHeartbeatCheckInterval() { return _heartbeatCheckInterval; }
export function setHeartbeatCheckInterval(v: ReturnType<typeof setInterval> | null) { _heartbeatCheckInterval = v; }

