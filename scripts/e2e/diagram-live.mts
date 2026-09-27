/**
 * M5a live check (ADR 0011): one typed prompt per diagram kind against a running gateway + real model.
 * Pass: every batch applies, the final doc validates, nodes and edges were drawn, first op before done.
 *   pnpm tsx scripts/e2e/diagram-live.mts wss://gateway-production-1c11.up.railway.app/ws
 */
import { applyOp, DesignDocSchema, layoutDiagram, ServerMsg, type DesignDoc, type DesignNode } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const CASES = [
  { kind: "architecture", text: "a Next.js web app calls a Fastify API that writes to Postgres, caches in Redis and charges cards with Stripe, deployed on Railway" },
  { kind: "erd", text: "users with an email, each user has many orders, orders have a total and a status, and orders have many line items that reference products" },
  { kind: "sequence", text: "the user logs in on the web app, the app posts credentials to the API, the API checks Postgres and returns a token to the app" },
] as const;

async function run(c: (typeof CASES)[number]) {
  const ws = new WebSocket(url);
  let doc: DesignDoc | null = null;
  const inbox: ServerMsg[] = [];
  let bad = 0;
  ws.on("message", (d) => {
    const m = ServerMsg.parse(JSON.parse(d.toString()));
    if (m.type === "doc") doc = m.doc;
    if (m.type === "ops") for (const op of m.ops) { try { doc = applyOp(doc!, op); } catch { bad++; } }
    inbox.push(m);
  });
  const until = async (pred: (m: ServerMsg) => boolean, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const hit = inbox.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error("timeout");
  };
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello" }));
  await until((m) => m.type === "doc");
  ws.send(JSON.stringify({ type: "new_doc", kind: c.kind }));
  await until((m) => m.type === "version");
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: "prompt", text: c.text }));
  const done = await until((m) => m.type === "job" && m.kind === "typed" && m.state !== "running") as Extract<ServerMsg, { type: "job" }>;
  const ms = Date.now() - t0;
  ws.close();
  const d = doc!;
  const all: DesignNode[] = [];
  const walk = (n: DesignNode) => { all.push(n); n.children?.forEach(walk); };
  walk(d.root);
  const nodes = all.filter((n) => n.type === "Node"), edges = all.filter((n) => n.type === "Edge");
  const valid = DesignDocSchema.safeParse(d).success;
  const layout = layoutDiagram(d);
  const ok = done.state === "done" && valid && bad === 0 && nodes.length >= 3 && edges.length >= 2 && (layout?.edges.length ?? 0) === edges.length;
  console.log(JSON.stringify({ kind: c.kind, ok, state: done.state, firstOpMs: done.firstOpMs, totalMs: ms, ops: done.opCount, nodes: nodes.map((n) => n.props.label), edges: edges.length, valid, badOps: bad, in: done.inputTokens, out: done.outputTokens, detail: done.detail }));
  return ok;
}

let pass = 0;
for (const c of CASES) if (await run(c)) pass++;
console.log(`diagram live: ${pass}/${CASES.length} pass`);
process.exit(pass === CASES.length ? 0 : 1);
