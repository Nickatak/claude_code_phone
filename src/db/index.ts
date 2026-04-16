/**
 * SQLite database singleton via Drizzle ORM.
 *
 * Creates the data directory and runs migrations on first access.
 * WAL mode for concurrent read/write (SSE readers + SDK writers).
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import path from "path";
import * as schema from "./schema";

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "..", "data", "remote-claude.db");

let db: ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    db = drizzle(sqlite, { schema });

    // Auto-create tables if they don't exist.
    // For a single-user app this is simpler than migration files.
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        session_id TEXT,
        cwd TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tool_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        message_id TEXT REFERENCES messages(id),
        tool_name TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        input TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}
