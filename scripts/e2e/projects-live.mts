/**
 * M6 live check (ADR 0016): the user's own example, spoken in general terms, becomes an architecture; then
 * the ERD view is described and knows the architecture's names; both views survive in one project.
 *   pnpm tsx scripts/e2e/projects-live.mts wss://gateway-production-1c11.up.railway.app/ws
 */
import { applyOp, DesignDocSchema, ServerMsg, viewDoc, type DesignDoc, type DesignNode } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const ws = new WebSocket(process.argv[2] ?? "ws://localhost:8787/ws");
const inbox: ServerMsg[] = [];
let doc: DesignDoc | null = null;
ws.on("message", (d) => { const m = ServerMsg.parse(JSON.parse(d.toString())); if (m.type === "doc") doc = m.doc; if (m.type === "ops") for (const op of m.ops) doc = applyOp(doc!, op); inbox.push(m); });
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); if (!ok) process.exitCode = 1; };
const until = async (pred: (m: ServerMsg) => boolean, from: number, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const h = inbox.slice(from).find(pred); if (h) return h; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error("timeout");
};
const send = (m: object) => { const at = inbox.length; ws.send(JSON.stringify(m)); return at; };
const typed = async (text: string) => until((m) => m.type === "job" && m.kind === "typed" && m.state !== "running", send({ type: "prompt", text })) as Promise<Extract<ServerMsg, { type: "job" }>>;
const labels = (n: DesignNode): string[] => [...(n.type === "Node" ? [String(n.props.label)] : []), ...(n.children ?? []).flatMap(labels)];
const owners = (n: DesignNode): string[] => [...(n.type === "Node" && n.props.owner ? [String(n.props.owner)] : []), ...(n.children ?? []).flatMap(owners)];

await new Promise((r) => ws.once("open", r));
await until((m) => m.type === "view", send({ type: "hello", ...(process.env.LC_ACCESS ? { access: process.env.LC_ACCESS } : {}) }));
await until((m) => m.type === "view" && m.view === "architecture", send({ type: "set_view", view: "architecture" }));
const j1 = await typed("our system works across MuleSoft, Salesforce, Genesys and Observe AI, with a Genesys bot, and a backend called Shaw that a full stack development team owns; MuleSoft connects Salesforce and Genesys to Shaw");
const arch = viewDoc(doc!, "architecture").root;
const got = labels(arch).map((l) => l.toLowerCase());
const want = ["mulesoft", "salesforce", "genesys", "observe", "genesys bot", "shaw"];
check("every named system is on the architecture", want.every((w) => got.some((g) => g.includes(w))), labels(arch));
check("the full-stack team is an owner badge, not a box", owners(arch).some((o) => /full/i.test(o)) && !got.some((g) => /team/.test(g)), owners(arch));
check("it has connections", (arch.children ?? []).filter((c) => c.type === "Edge").length >= 2);
await until((m) => m.type === "view" && m.view === "erd", send({ type: "set_view", view: "erd" }));
const prompts = inbox.length;
const j2 = await typed("customers and their support cases, each customer has many cases");
const erd = viewDoc(doc!, "erd").root;
check("the ERD was drawn in its own view", labels(erd).length >= 2, labels(erd));
check("the architecture is untouched", JSON.stringify(viewDoc(doc!, "architecture").root) === JSON.stringify(arch));
check("the whole project validates", DesignDocSchema.safeParse(doc).success);
const notes = inbox.slice(prompts).find((m) => m.type === "job" && m.kind === "notes");
console.log(JSON.stringify({ archFirstOpMs: j1.firstOpMs, archTokens: [j1.inputTokens, j1.outputTokens], erdFirstOpMs: j2.firstOpMs, erdTokens: [j2.inputTokens, j2.outputTokens], notesJob: !!notes, notes: (doc as DesignDoc | null)?.root.props.notes }));
ws.close();
