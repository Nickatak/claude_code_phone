import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "fs";
import path from "path";
import * as schema from "./schema";

/**
 * Path to the SQLite database file.
 * Lives on the relay server (Pixel 3a), NOT on the worker PC.
 * Defaults to ./data/relay.db relative to the project root.
 */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "relay.db");

let db: ReturnType<typeof drizzle>;

/**
 * Returns a singleton Drizzle ORM instance backed by better-sqlite3.
 *
 * On first call:
 * - Creates the data directory if it doesn't exist
 * - Opens the SQLite connection with WAL mode (better concurrent read performance)
 *   and foreign key enforcement
 * - Runs any pending Drizzle migrations from the /drizzle folder
 *
 * Subsequent calls return the cached instance.
 */
export function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    const sqlite = new Database(DB_PATH);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  }
  return db;
}
