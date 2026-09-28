import { PGlite } from "@electric-sql/pglite";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateProject, parseImport, type CodeFile, type ServerMsg } from "@livecanvas/dsl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocSession } from "../src/engine/docSession.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

/**
 * Build it (ADR 0022) acceptance, local (no CI exists — plan-critic M10 #4): a project spoken + imported through
 * the real engine → generated SQL applies to Postgres (PGlite) and the generated TypeScript typechecks.
 */
const none: ModelClient = () => ({ lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repo = resolve(import.meta.dirname, "../../..");
let files: CodeFile[] = [];
let d: DocSession;

beforeAll(async () => {
  const persistence = memoryPersistence();
  const sent: ServerMsg[] = [];
  d = new DocSession(await persistence.openSession(), { persistence, model: none, send: (m) => sent.push(m), engine: { model: "m", system: "s", render: () => "" } });
  let seq = 0;
  const say = async (text: string) => {
    const w = text.split(" "), s = seq++;
    for (let n = 1; n <= w.length; n++) { d.onTranscript(s, w.slice(0, n).join(" "), n === w.length, n * 300); await sleep(2); }
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) await sleep(3);
    await sleep(10);
  };
  await say("a login screen with email and password, big blue sign-in button, logo on top");
  // Relations need Jev/the model when spoken; imported, they're deterministic — and exercise import end to end.
  expect(d.applyImport(`create table customers (id uuid primary key, email text, name text);
    create table agents (id uuid primary key, name text);
    create table cases (id uuid primary key, subject text, status text, priority int, opened_at timestamptz,
      customer_id uuid references customers(id), agent_id uuid references agents(id));`, "support.sql").applied).toBe(true);
  expect(d.applyImport(JSON.stringify({ dependencies: { next: "15", fastify: "5", pg: "8", "@sendgrid/mail": "8" } }), "package.json").applied).toBe(true);
  files = generateProject(d.project);
});

describe("generated code (ADR 0022)", () => {
  it("every worker writes its files; paths are safe", () => {
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["db/schema.sql", "packages/contracts/src/index.ts", "apps/api/src/server.ts", "apps/api/src/routes/cases.ts", "apps/web/app/page.tsx", "docker-compose.yml", "load/k6.js", "PRD.md", "BACKLOG.md", "README.md", ".env.example"]));
    for (const p of paths) expect(p).toMatch(/^[a-z0-9_./-]+$/i), expect(p).not.toMatch(/\.\.|^\//);
    expect(files.find((f) => f.path === ".env.example")!.content).toContain("SENDGRID_API_KEY=");
  });

  it("the SQL applies to Postgres 16 — ours and an imported pg schema (our own db/schema.sql, round-tripped)", async () => {
    const pg = new PGlite();
    await pg.exec(files.find((f) => f.path === "db/schema.sql")!.content);
    const t = await pg.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema='public'");
    expect(t.rows[0]!.n).toBeGreaterThanOrEqual(4); // users, customers, cases, agents
    const fk = await pg.query<{ n: number }>("select count(*)::int as n from information_schema.table_constraints where constraint_type='FOREIGN KEY'");
    expect(fk.rows[0]!.n).toBeGreaterThanOrEqual(2);
    // Round trip: import our real schema, generate SQL from the ERD, apply it.
    const persistence = memoryPersistence();
    const d2 = new DocSession(await persistence.openSession(), { persistence, model: none, send: () => {}, engine: { model: "m", system: "s", render: () => "" } });
    const r = d2.applyImport(readFileSync(resolve(repo, "db/schema.sql"), "utf8"), "schema.sql");
    expect(r.applied).toBe(true);
    const pg2 = new PGlite();
    await pg2.exec(generateProject(d2.project, ["db"])[0]!.content);
    const t2 = await pg2.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema='public'");
    expect(t2.rows[0]!.n).toBe(parseImport(readFileSync(resolve(repo, "db/schema.sql"), "utf8"))!.tables.length);
  }, 60_000);

  it("the API and contracts typecheck; the web page typechecks", () => {
    const write = (root: string, pick: (f: CodeFile) => boolean) => {
      rmSync(root, { recursive: true, force: true });
      for (const f of files.filter(pick)) { const p = resolve(root, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
    };
    const tsc = resolve(repo, "apps/gateway/node_modules/.bin/tsc");
    const api = resolve(repo, "apps/gateway/.codegen-test");
    write(api, (f) => f.path.startsWith("apps/api/src") || f.path.startsWith("packages/contracts"));
    writeFileSync(resolve(api, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true, types: ["node"] }, include: ["apps", "packages"] }));
    expect(() => execFileSync(tsc, ["-p", api], { encoding: "utf8" })).not.toThrow();
    const web = resolve(repo, "apps/web/.codegen-test");
    write(web, (f) => f.path.endsWith(".tsx"));
    writeFileSync(resolve(web, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true, jsx: "react-jsx" }, include: ["apps"] }));
    expect(() => execFileSync(tsc, ["-p", web], { encoding: "utf8" })).not.toThrow();
  }, 120_000);

  it("the browser's zip writer produces an archive unzip accepts, byte-identical", async () => {
    const { zip } = await import("../../web/lib/zip.js");
    const dir = resolve(repo, "apps/gateway/.codegen-test/zip");
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "app.zip"), zip(files));
    expect(execFileSync("unzip", ["-t", "app.zip"], { cwd: dir, encoding: "utf8" })).toMatch(/No errors detected/);
    execFileSync("unzip", ["-q", "app.zip", "-d", "out"], { cwd: dir });
    for (const f of files) expect(readFileSync(resolve(dir, "out", f.path), "utf8")).toBe(f.content);
  });

  it("is fast and deterministic", () => {
    const t = performance.now();
    for (let i = 0; i < 20; i++) generateProject(d.project);
    expect((performance.now() - t) / 20).toBeLessThan(200);
    expect(JSON.stringify(generateProject(d.project))).toBe(JSON.stringify(files));
  });
});

afterAll(() => {
  rmSync(resolve(repo, "apps/gateway/.codegen-test"), { recursive: true, force: true });
  rmSync(resolve(repo, "apps/web/.codegen-test"), { recursive: true, force: true });
});
