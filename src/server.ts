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
import { getDb } from "./db/index";
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

// Initialize database on startup
getDb();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Pocket Claude listening on 0.0.0.0:${PORT}`);
});
