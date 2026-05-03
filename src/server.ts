/**
 * Pocket Claude v2 - Express server entry point.
 *
 * Single server that serves the mobile PWA frontend, provides REST
 * endpoints for conversation management, and streams tool events via
 * SSE. No relay, no separate worker - the SDK runs as a child process
 * directly from this server.
 */

import express from "express";
import path from "path";
import type { Server } from "http";
import { closeDb, runMigrations } from "./db/index";
import { abortAllAndWait } from "./sdk/process-manager";
import { conversationRouter } from "./routes/conversations";

const PORT = parseInt(process.env.PORT || "9800", 10);

const app = express();

app.use(express.json());

// Static frontend (PWA)
app.use(express.static(path.join(__dirname, "..", "public")));

// API routes
app.use("/api/conversations", conversationRouter);

// SPA fallback - serve index.html for any unmatched route
// Express 5 requires named wildcard params instead of bare *
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

let server: Server | null = null;
let shuttingDown = false;

/**
 * Graceful shutdown: stop taking new HTTP, abort active SDK runs and
 * wait for their terminal writes, drain the DB pool, exit. Docker
 * gives ~10s after SIGTERM before SIGKILL - the bounded path here
 * lands well inside that window.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully`);

  if (server) {
    server.close();
  }

  try {
    await abortAllAndWait();
  } catch (err) {
    console.error("Error aborting SDK processes:", err);
  }

  try {
    await closeDb();
  } catch (err) {
    console.error("Error closing DB pool:", err);
  }

  console.log("Shutdown complete");
  process.exit(0);
}

async function main(): Promise<void> {
  await runMigrations();
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Pocket Claude listening on 0.0.0.0:${PORT}`);
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
