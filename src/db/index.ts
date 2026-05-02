/**
 * Postgres connection pool and drizzle handle.
 *
 * Migrations run from ./drizzle on first init. The pool itself is lazy -
 * the first query opens a connection. Process shutdown should `pool.end()`
 * to drain in-flight work, but we don't wire that yet.
 */

import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "path";
import * as schema from "./schema";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;

function buildPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  return new Pool({ connectionString: url });
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    pool = buildPool();
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Run pending migrations. Call once at startup before serving traffic. */
export async function runMigrations(): Promise<void> {
  const handle = getDb();
  await migrate(handle, {
    migrationsFolder: path.join(__dirname, "..", "..", "drizzle"),
  });
}
