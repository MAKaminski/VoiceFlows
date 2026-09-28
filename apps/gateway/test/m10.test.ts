import { viewDoc, type ServerMsg } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { DocSession } from "../src/engine/docSession.js";
import { checkFill, runFill } from "../src/engine/fill.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

/** M10 (ADR 0022): import is one undoable version; the AI-fill pool is bounded and never loses the skeleton. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const none: ModelClient = () => ({ lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });

describe("import (ADR 0022)", () => {
  it("one version, one undo; merges into existing tables; refused mid-sentence", async () => {
    const persistence = memoryPersistence();
    const sent: ServerMsg[] = [];
    const d = new DocSession(await persistence.openSession(), { persistence, model: none, send: (m) => sent.push(m), engine: { model: "m", system: "s", render: () => "" } });
    const versions = () => sent.filter((m) => m.type === "version").length;
    const tables = () => (viewDoc(d.project, "erd").root.children ?? []).filter((n) => n.type === "Node").map((n) => `${n.props.label}:${(n.props.cols as string[]).length}`);
    const v0 = versions();
    expect(d.applyImport("create table customers (id uuid primary key, email text); create table cases (id uuid primary key, customer_id uuid references customers(id));").applied).toBe(true);
    expect(versions()).toBe(v0 + 1);
    expect(tables()).toEqual(["customers:2", "cases:2"]);
    expect(viewDoc(d.project, "architecture").root.children!.some((l) => l.children?.some((c) => c.props.label === "Database"))).toBe(true); // scaffolded
    // Existing table: the missing column is merged, not a second table.
    expect(d.applyImport("create table customers (id uuid, phone text);").applied).toBe(true);
    expect(tables()).toEqual(["customers:3", "cases:2"]);
    expect(d.applyImport("create table customers (id uuid, phone text);")).toMatchObject({ applied: false });
    d.undo();
    expect(tables()).toEqual(["customers:2", "cases:2"]);
    d.undo();
    expect(tables()).toEqual([]);
    d.onTranscript(0, "a login screen with", false, 300);
    expect(d.applyImport("create table x (id int);")).toMatchObject({ applied: false, summary: expect.stringMatching(/Busy/) });
    expect(d.applyImport("just some words")).toMatchObject({ applied: false, kind: null });
  });
});

describe("AI fill workers (ADR 0022)", () => {
  const skeleton = (i: number) => ({ path: `apps/api/src/routes/t${i}.ts`, content: `export async function t${i}Routes() {\n  // TODO\n}\n` });
  const fake = (body: (user: string) => string, delay = 20, usage = { inputTokens: 1500, outputTokens: 800 }) => {
    let live = 0, peak = 0;
    const client: ModelClient = ({ user, signal }) => ({
      lines: (async function* () {
        live++; peak = Math.max(peak, live);
        try { await new Promise((r, j) => { const t = setTimeout(r, delay); signal.addEventListener("abort", () => { clearTimeout(t); j(new Error("aborted")); }); }); for (const line of body(user).split("\n")) yield { line, atMs: 1 }; }
        finally { live--; }
      })(),
      usage: Promise.resolve(usage),
    });
    return { client, peak: () => peak };
  };
  const base = { prd: "# PRD", modelName: "m", system: "s", render: (v: Record<string, string>) => `${v.path}\n${v.content}` };

  it("4 workers at most, every file comes back filled, indentation kept, cost counted", async () => {
    const sent: ServerMsg[] = [];
    const f = fake((u) => { const name = /t(\d+)Routes/.exec(u)![1]; return `export async function t${name}Routes() {\n  return "real";\n}`; });
    const r = await runFill({ ...base, files: Array.from({ length: 10 }, (_, i) => skeleton(i)), model: f.client, send: (m) => sent.push(m) });
    expect(f.peak()).toBe(4);
    expect(r).toMatchObject({ filled: 10, failed: 0 });
    expect(r.usd).toBeCloseTo(10 * (1500 * 1 + 800 * 5) / 1e6, 5); // $0.055
    const done = sent.filter((m): m is Extract<ServerMsg, { type: "fill_file" }> => m.type === "fill_file" && m.status === "done");
    expect(done[0]!.content).toContain('\n  return "real";\n');
    expect(sent.at(-1)!.type).toBe("fill_done");
  });

  it("the budget stops new files; bad output keeps the skeleton; non-source files are skipped", async () => {
    const sent: ServerMsg[] = [];
    const f = fake(() => "export async function somethingElse() {");
    const files = [...Array.from({ length: 12 }, (_, i) => skeleton(i)), { path: "README.md", content: "# x" }];
    const r = await runFill({ ...base, files, model: f.client, send: (m) => sent.push(m), maxUsd: 0.05 });
    expect(r.filled).toBe(0);
    expect(r.failed).toBe(12); // README never queued
    const errs = sent.flatMap((m) => (m.type === "fill_file" && m.status === "failed" ? [m.error] : []));
    expect(errs.filter((e) => /lost export/.test(e!)).length).toBe(4); // $0.05 ÷ $0.012 worst case = 4 started
    expect(errs.filter((e) => /budget/.test(e!)).length).toBe(8);
  });

  it("times out as a whole, and checks catch truncation", async () => {
    const sent: ServerMsg[] = [];
    const f = fake(() => "never", 5_000);
    const t = performance.now();
    const r = await runFill({ ...base, files: [skeleton(1), skeleton(2)], model: f.client, send: (m) => sent.push(m), timeoutMs: 100 });
    expect(performance.now() - t).toBeLessThan(1_000);
    expect(r.failed).toBe(2);
    expect(checkFill("export const A = 1;", "export const A = { b: `}`, c: '{' ;")).toBe("unbalanced braces");
    expect(checkFill("export function a() {}", "export function a() { const s = \"}\"; }")).toBeNull();
    // JSX text with an apostrophe is not a string (seen on the first real fill, 2026-09-28).
    expect(checkFill("export default function Page() {}", "export default function Page() {\n  return <p>Don't have an account?</p>;\n}", "apps/web/app/page.tsx")).toBeNull();
    await sleep(0);
  });
});
