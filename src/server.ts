import "./env";
import http from "http";
import { WebSocketServer } from "ws";
import { getDb } from "./db";
import { app } from "./server/routes";
import { getSession } from "./server/sessions";
import { setupWorkerWs } from "./server/ws-worker";
import { setupClientWs } from "./server/ws-client";

const PORT = parseInt(process.env.PORT || "3000", 10);

// --- HTTP + WebSocket servers ---

const server = http.createServer(app);

const workerWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

setupWorkerWs(workerWss);
setupClientWs(clientWss);

// --- WebSocket upgrade routing ---

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

// --- Start ---

server.listen(PORT, "0.0.0.0", () => {
  getDb();
  console.log(`Relay server listening on 0.0.0.0:${PORT}`);
});
