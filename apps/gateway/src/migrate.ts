import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultTokens, propSchemas } from "@livecanvas/dsl";
import postgres from "postgres";
import { z } from "zod";
import { ANON_EMAIL } from "./persist.js";

/**
 * Pre-deploy step (Railway preDeployCommand): applies db/schema.sql once, over the private
 * network, if the schema is absent (an existing `users` table means "already applied"), then
 * upserts seed rows every deploy: the `default` token set and the 12 primitives, both generated
 * from packages/dsl so code stays the source of truth (ARCHITECTURE.md F2), and the anonymous
 * user that sessions belong to until magic-link auth (M5).
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
    await applyMigrations(sql, join(dirname(file), "migrations"));
    await seed(sql);
    const { tables } = (await sql<{ tables: number }[]>`select count(*)::int as tables from information_schema.tables where table_schema = 'public'`)[0]!;
    const { fks } = (await sql<{ fks: number }[]>`select count(*)::int as fks from information_schema.table_constraints where constraint_type = 'FOREIGN KEY' and table_schema = 'public'`)[0]!;
    console.log(`migrate: tables=${tables} fks=${fks}`);
  } finally {
    await sql.end();
  }
}

/** Idempotent ALTERs for databases created before schema.sql changed; run in name order every deploy. */
async function applyMigrations(sql: postgres.Sql, dir: string) {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(); } catch { return; }
  for (const f of files) {
    await sql.begin((tx) => tx.unsafe(readFileSync(join(dir, f), "utf8")));
    console.log(`migrate: applied migration ${f}`);
  }
}

async function seed(sql: postgres.Sql) {
  await sql`insert into users (email) values (${ANON_EMAIL}) on conflict (email) do nothing`;
  const tokens = sql.json(defaultTokens as never);
  const updated = await sql`update token_sets set tokens = ${tokens} where name = 'default'`;
  if (updated.count === 0) await sql`insert into token_sets (name, tokens) values ('default', ${tokens})`;
  for (const [name, schema] of Object.entries(propSchemas)) {
    const json = sql.json(z.toJSONSchema(schema) as never);
    await sql`insert into primitives (name, prop_schema) values (${name}, ${json})
              on conflict (name) do update set prop_schema = excluded.prop_schema`;
  }
  console.log(`migrate: seeded anonymous user, default token set, ${Object.keys(propSchemas).length} primitives`);
}

main().catch((err) => {
  console.error("migrate: failed", err);
  process.exit(1);
});
