// Runs any db/migrations/*.sql file not yet recorded in schema_migrations, in filename
// order, each inside its own transaction. Safe to re-run: already-applied files are skipped.
// Run: npm run migrate

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const DATABASE_URL_DIRECT = process.env.DATABASE_URL_DIRECT;
if (!DATABASE_URL_DIRECT) {
  throw new Error("DATABASE_URL_DIRECT is not set (see .env.local) -- migrations need the direct, non-pooled connection");
}

// Own connection, separate from lib/db.ts's pooled one: DDL (CREATE INDEX, CREATE
// EXTENSION, ...) can misbehave through a transaction-mode pooler.
const sql = postgres(DATABASE_URL_DIRECT, { prepare: false });

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

async function main() {
  // Bootstrap table for the migration runner itself -- not part of the app's schema, so it
  // isn't defined in a migration file; it has to exist before we can even ask it what's
  // already been applied.
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set((await sql`SELECT filename FROM schema_migrations`).map((r) => r.filename as string));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  let ranCount = 0;
  for (const filename of files) {
    if (applied.has(filename)) {
      console.log(`[migrate] ${filename}: already applied, skipping`);
      continue;
    }
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const fileSql = await readFile(filePath, "utf-8");
    console.log(`[migrate] ${filename}: applying...`);
    // One transaction per file: if the file's SQL fails partway through, none of it is
    // recorded as applied, so a corrected re-run doesn't skip a half-applied migration.
    await sql.begin(async (tx) => {
      await tx.unsafe(fileSql);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
    });
    console.log(`[migrate] ${filename}: applied`);
    ranCount++;
  }

  console.log(`[migrate] Done. ${ranCount} file(s) applied, ${files.length - ranCount} already up to date.`);
}

main()
  .catch((err) => {
    console.error("[migrate] FAILED:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end());
