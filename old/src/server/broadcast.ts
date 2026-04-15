import { WebSocket } from "ws";
import { clientSockets } from "./state";
import type { SessionData } from "./sessions";

/**
 * Send a message to connected clients.
 * If deviceId is provided, only sends to that device's clients (tenant isolation).
 * If omitted, broadcasts to all clients (status updates).
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
