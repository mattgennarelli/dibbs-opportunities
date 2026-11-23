// Pooled Postgres connection for the app and for ingest's writes. Migrations use their own
// direct (non-pooled) connection instead -- see scripts/migrate.ts.

import postgres from "postgres";

let client: postgres.Sql | null = null;

// Created lazily, on first actual use, rather than at module-import time. `next build`
// imports every route module to collect its config (e.g. whether it's dynamic) -- it does
// NOT invoke the route's GET/POST handlers, but a throw at module scope (the old behavior
// here) fires regardless, failing the build whenever DATABASE_URL isn't set in the build
// environment. The build genuinely has no need to ever touch Postgres, so this must only
// throw if a request handler actually runs a query without DATABASE_URL configured.
function ensureClient(): postgres.Sql {
  if (client) return client;
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see .env.local)");
  }
  // prepare: false -- Neon's pooled endpoint runs PgBouncer in transaction mode, which
  // doesn't support prepared statements persisting across connections from the pool.
  client = postgres(DATABASE_URL, { prepare: false });
  return client;
}

// A Proxy so every existing call site (`sql\`...\``, `sql.begin(...)`, `sql.unsafe(...)`,
// etc.) keeps working unchanged -- callers don't need to know the real client is created
// lazily behind this.
export const sql: postgres.Sql = new Proxy(function sql() {} as unknown as postgres.Sql, {
  apply(_target, _thisArg, args) {
    const real = ensureClient();
    return (real as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop, receiver) {
    const real = ensureClient();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
