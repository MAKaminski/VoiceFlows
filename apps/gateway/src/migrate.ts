import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

/**
 * Pre-deploy step (Railway preDeployCommand): applies db/schema.sql once, over the private
 * network, if the schema is absent. Idempotent: an existing `users` table means "already applied".
 * Real versioned migrations arrive with M5 (ASSUMPTIONS.md, 2026-09-26).
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const file = process.env.SCHEMA_PATH ?? resolve(process.cwd(), "db/schema.sql");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const { exists } = (await sql<{ exists: boolean }[]>`select to_regclass('public.users') is not null as exists`)[0]!;
    if (exists) console.log("migrate: schema already present, skipping");
    else {
      await sql.begin((tx) => tx.unsafe(readFileSync(file, "utf8")));
      console.log("migrate: applied", file);
    }
    const { tables } = (await sql<{ tables: number }[]>`select count(*)::int as tables from information_schema.tables where table_schema = 'public'`)[0]!;
    const { fks } = (await sql<{ fks: number }[]>`select count(*)::int as fks from information_schema.table_constraints where constraint_type = 'FOREIGN KEY' and table_schema = 'public'`)[0]!;
    console.log(`migrate: tables=${tables} fks=${fks}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("migrate: failed", err);
  process.exit(1);
});
