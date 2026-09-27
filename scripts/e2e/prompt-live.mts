/**
 * M3 acceptance against a running gateway + real model (no browser):
 *  - "add a login form" yields ops that validate;
 *  - the first op arrives before the stream ends;
 *  - undo restores the exact prior doc.
 *   pnpm tsx scripts/e2e/prompt-live.mts wss://gateway-production-1c11.up.railway.app/ws [runs]
 */
import { applyOp, DesignDocSchema, ServerMsg, type DesignDoc } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const runs = Number(process.argv[3] ?? 5);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!; };

async function once(i: number) {
  const ws = new WebSocket(url);
  const inbox: Array<{ m: ServerMsg; at: number }> = [];
  let doc: DesignDoc | null = null;
  let wake = () => {};
  ws.on("message", (d) => {
    const m = ServerMsg.parse(JSON.parse(d.toString()));
    if (m.type === "doc") doc = m.doc;
    if (m.type === "ops") for (const op of m.ops) doc = applyOp(doc!, op);
    inbox.push({ m, at: performance.now() });
    wake();
  });
  const until = async (pred: (m: ServerMsg) => boolean, ms = 15000) => {
    const deadline = performance.now() + ms;
    for (;;) {
      const hit = inbox.find((x) => pred(x.m)); if (hit) return hit;
      if (performance.now() > deadline) throw new Error("timeout");
      await new Promise<void>((r) => { wake = r; setTimeout(r, 50); });
    }
  };
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello" }));
  await until((m) => m.type === "doc");
  const v0 = structuredClone(doc);
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
  const end = await until((m) => m.type === "job" && m.state !== "running");
  const firstOps = inbox.find((x) => x.m.type === "ops");
  const valid = DesignDocSchema.safeParse(doc).success;
  const kids = (doc as DesignDoc | null)?.root.children?.map((n) => `${n.type}${n.props.label || n.props.content ? `(${n.props.label ?? n.props.content})` : ""}`) ?? [];
  const nVersion = inbox.filter((x) => x.m.type === "version").length;
  ws.send(JSON.stringify({ type: "undo" }));
  await until((m) => m.type === "version" && m.version === 0);
  await new Promise((r) => setTimeout(r, 100));
  const undoExact = JSON.stringify(doc) === JSON.stringify(v0);
  ws.close();
  const r = {
    state: (end.m as { state: string }).state,
    firstOpMs: firstOps ? Math.round(firstOps.at - t0) : NaN,
    jobEndMs: Math.round(end.at - t0),
    firstBeforeEnd: !!firstOps && firstOps.at < end.at,
    opCount: (end.m as { opCount?: number }).opCount ?? 0,
    valid, undoExact, versionsWritten: nVersion, kids,
  };
  console.log(`run ${i + 1}: ${r.state} · first op ${r.firstOpMs} ms · done ${r.jobEndMs} ms · ${r.opCount} ops · valid ${r.valid} · undo exact ${r.undoExact} · ${kids.join(", ")}`);
  return r;
}

const rs = [];
for (let i = 0; i < runs; i++) rs.push(await once(i));
const pass = rs.every((r) => r.state === "done" && r.valid && r.firstBeforeEnd && r.undoExact && r.opCount > 0);
console.log(`M3 acceptance over ${runs} runs: first op p50 ${pct(rs.map((r) => r.firstOpMs), 50)} ms (client, incl. network) · job end p50 ${pct(rs.map((r) => r.jobEndMs), 50)} ms · ${pass ? "PASS" : "FAIL"}`);
console.log(`PROMPT_RESULT ${JSON.stringify({ url, at: new Date().toISOString(), runs: rs })}`);
