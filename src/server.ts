import "./env";
import http from "http";
import { WebSocketServer } from "ws";
import { getDb } from "./db";
import { app } from "./server/routes";
import { getSession } from "./server/sessions";
import { setupWorkerWs } from "./server/ws-worker";
import { setupClientWs } from "./server/ws-client";

const PORT = parseInt(process.env.PORT || "3000", 10);

const server = http.createServer(app);

const workerWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

setupWorkerWs(workerWss);
setupClientWs(clientWss);

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

server.listen(PORT, "0.0.0.0", () => {
  getDb(); // init db + run migrations on startup
  console.log(`Relay server listening on 0.0.0.0:${PORT}`);
});
