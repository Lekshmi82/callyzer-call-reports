import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { projectRoot } from "../lib/paths.js";
import type { Logger } from "../logger.js";

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates (avoids TZ shifts).
pg.types.setTypeParser(1082, (v: string) => v);

export type Db = pg.Pool;

export function createPool(databaseUrl: string, ssl: "disable" | "require" | "no-verify"): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    ssl: ssl === "disable" ? undefined : { rejectUnauthorized: ssl === "require" },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

const MIGRATION_LOCK = 72_311_001;

/** Applies migrations/*.sql in order, once each, under an advisory lock (safe with several instances). */
export async function migrate(db: Db, log: Logger): Promise<void> {
  const dir = path.join(projectRoot, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log.info({ migration: file }, "applied migration");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
