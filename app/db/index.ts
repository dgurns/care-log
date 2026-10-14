import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DB_FILE_NAME ?? 'file:local.db',
});

export const db = drizzle(client);

// Schema migrations, run on every startup (locally and in prod).
//
// Workflow for a schema change:
//   1. Edit app/db/schema.ts
//   2. Add a matching block at the END of this function
//   3. Restart the dev server to apply locally; `make deploy` applies in prod
//
// Rules:
//   - Do NOT run `npm run db:push` against an existing database. drizzle-kit
//     0.31 rebuilds every table on each push and crashes partway through
//     (non-transactionally) when adding a column. Only use db:push to create
//     tables in a brand-new, empty database.
//   - Every block must be idempotent (check first, e.g. "if column missing"),
//     since this runs on every startup.
//   - Append new blocks; never edit or reorder existing ones.
//   - Prefer additive changes (nullable columns, CREATE TABLE IF NOT EXISTS,
//     CREATE INDEX IF NOT EXISTS). During a deploy the old app version briefly
//     runs against the migrated DB, so renames/drops can break it.
//   - Keep the SQL here in sync with schema.ts by hand; nothing checks this.
//   - Back up prod first (`make pull-prod-db-to-local`).
//   - If a migration throws, the app won't boot, so Kamal's health check fails
//     and the previous version keeps running.
async function runStartupMigrations() {
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='medical_detail'",
  );
  // Fresh DB: let `drizzle-kit push` create the tables
  if (tables.rows.length === 0) return;

  const columns = await client.execute("PRAGMA table_info(medical_detail)");
  const hasUserRawContent = columns.rows.some(
    (row) => row.name === "user_raw_content",
  );
  if (!hasUserRawContent) {
    await client.execute(
      "ALTER TABLE medical_detail ADD COLUMN user_raw_content text",
    );
    console.log("Migration: added medical_detail.user_raw_content");
  }
}

await runStartupMigrations();
