import postgres from "postgres";

let sql: postgres.Sql | null = null;

/** Lazily-created shared Postgres client; null when DATABASE_URL is unset (tests, DB-less dev). */
export function getSql(url = process.env.DATABASE_URL): postgres.Sql | null {
  if (!url) return null;
  sql ??= postgres(url, { max: 5, idle_timeout: 30, onnotice: () => {} });
  return sql;
}
