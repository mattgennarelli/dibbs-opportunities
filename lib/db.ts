// Pooled Postgres connection for the app and for ingest's writes. Migrations use their own
// direct (non-pooled) connection instead -- see scripts/migrate.ts.

import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (see .env.local)");
}

// prepare: false -- Neon's pooled endpoint runs PgBouncer in transaction mode, which
// doesn't support prepared statements persisting across connections from the pool.
export const sql = postgres(DATABASE_URL, { prepare: false });
