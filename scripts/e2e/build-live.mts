/**
 * M10 live check (ADR 0022): import our own db/schema.sql into a fresh production session, generate the
 * codebase from the resulting doc (the browser's generator), and run one real AI fill over the skeletons.
  * Usage: LC_ACCESS=<full token> tsx scripts/e2e/build-live.mts wss://…/ws
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { generateProject, toProject, type DesignDoc } from "../../packages/dsl/src/index.js";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const ws = new WebSocket(url);
const inbox: any[] = [];
const waiters: Array<[(m: any) => boolean, (m: any) => void]> = [];
ws.on("message", (d) => { const m = JSON.parse(String(d)); inbox.push(m); for (const w of [...waiters]) if (w[0](m)) { waiters.splice(waiters.indexOf(w), 1); w[1](m); } });
const next = (p: (m: any) => boolean, ms = 60_000) => new Promise<any>((res, rej) => { const hit = inbox.find(p); if (hit) return res(hit); waiters.push([p, res]); setTimeout(() => rej(new Error("timeout")), ms); });
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello", ...(process.env.LC_ACCESS ? { access: process.env.LC_ACCESS } : {}) }));
const welcome = await next((m) => m.type === "welcome" || m.type === "error");
if (welcome.type === "error") throw new Error(welcome.message);
console.log(`flags: code_scaffold=${welcome.flags?.code_scaffold} code_scaffold_model=${welcome.flags?.code_scaffold_model} context_import=${welcome.flags?.context_import}`);
const sql = readFileSync(resolve(import.meta.dirname, "../../db/schema.sql"), "utf8");
let t = performance.now();
ws.send(JSON.stringify({ type: "import", text: sql, name: "schema.sql" }));
const r = await next((m) => m.type === "import_result");
console.log(`import: ${JSON.stringify(r)} · ${Math.round(performance.now() - t)} ms round trip`);
// The doc after the import, as the browser would hold it: replay the snapshot + ops.
const { applyOp } = await import("../../packages/dsl/src/index.js");
let doc: DesignDoc = toProject(inbox.find((m) => m.type === "doc").doc);
for (const m of inbox) if (m.type === "ops") for (const op of m.ops) doc = applyOp(doc, op);
t = performance.now();
const files = generateProject(doc);
console.log(`generate: ${files.length} files · ${(performance.now() - t).toFixed(1)} ms · routes ${files.filter((f) => f.path.includes("/routes/")).length}`);
const fillable = files.filter((f) => /^apps\/(api\/src\/(routes|clients)\/[a-z0-9_-]+\.ts|web\/app\/page\.tsx)$/.test(f.path)).slice(0, 12);
ws.send(JSON.stringify({ type: "fill", files: fillable.map((f) => ({ path: f.path, content: f.content.slice(0, 16384) })) }));
const done = await next((m) => m.type === "fill_done" || (m.type === "error" && /fill/i.test(m.message)), 90_000);
const peak = Math.max(...inbox.filter((m) => m.type === "fill_file").map((m) => m.worker));
console.log(`fill: ${JSON.stringify(done)} · workers used ${peak} · failures ${JSON.stringify(inbox.filter((m) => m.type === "fill_file" && m.status === "failed").map((m) => `${m.path}: ${m.error}`))}`);
ws.close();
