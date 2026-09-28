/**
 * M7 fluency corpus, live (ADR 0019). Each case gets a fresh project on the deployed gateway; its setup
 * sentences and then the sentence under test are streamed word by word as STT partials (~2.9 words/s, the
 * last one final + eager, like Flux's end of turn). When the sentence settles, the design is scored
 * against the case's expectations (scripts/corpus/score.ts).
 *
 * Upper bound, by design: partials skip Flux itself (revisions, chunking, its ~685 ms end-of-turn), so
 * settle here is measured from the final partial. voice-accept.mts (real audio) stays the DoD gate.
 *   pnpm tsx scripts/e2e/corpus-live.mts wss://gateway-production-1c11.up.railway.app/ws [filter] [concurrency]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { applyOp, ServerMsg, type DesignDoc } from "../../packages/dsl/src/index.js";
import { CASES, type CorpusCase, type View } from "../corpus/cases.js";
import { score } from "../corpus/score.js";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const filter = process.argv[3] && process.argv[3] !== "all" ? new RegExp(process.argv[3]) : null;
const CONCURRENCY = Number(process.argv[4] ?? 4);
const WORD_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!); };

interface Result { id: string; view: View; pass: boolean; known?: string; failures: string[]; settleMs: number | null; firstOpMs: number | null; calls: number; jev: number; usd: number; say: string }

async function runCase(c: CorpusCase): Promise<Result> {
  const ws = new WebSocket(url);
  let doc: DesignDoc | null = null;
  let view: View = "screen";
  const inbox: Array<{ m: ServerMsg; at: number }> = [];
  let running = 0;
  ws.on("message", (d) => {
    const m = ServerMsg.parse(JSON.parse(d.toString()));
    const at = performance.now();
    if (m.type === "doc") doc = m.doc;
    if (m.type === "ops" && doc) for (const op of m.ops) doc = applyOp(doc, op);
    if (m.type === "view") view = m.view;
    if (m.type === "job") running += m.state === "running" ? 1 : -1;
    inbox.push({ m, at });
  });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const until = async (pred: (m: ServerMsg) => boolean, from: number, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const h = inbox.slice(from).find((x) => pred(x.m)); if (h) return h; await sleep(25); }
    return null;
  };
  const send = (m: object) => { const at = inbox.length; ws.send(JSON.stringify(m)); return at; };
  await until((m) => m.type === "doc", send({ type: "hello" }));
  if (c.view !== "screen") await until((m) => m.type === "view" && m.view === c.view, send({ type: "set_view", view: c.view }));

  let seq = 0, t = 0;
  let last = { settleMs: null as number | null, firstOpMs: null as number | null, from: 0 };
  for (const sentence of [...(c.setup ?? []), c.say]) {
    const words = sentence.split(" ");
    const from = inbox.length;
    const t0 = performance.now();
    for (let n = 1; n <= words.length; n++) {
      t += WORD_MS;
      const final = n === words.length;
      send({ type: "partial", utteranceSeq: seq, text: words.slice(0, n).join(" "), isFinal: final, tMs: t, lastWordEndMs: t, ...(final ? { eager: true } : {}) });
      if (!final) await sleep(WORD_MS);
    }
    const finalAt = performance.now();
    // Settled = a version arrived, or nothing is running and nothing new came for 2.5 s (no change to commit).
    let settledAt: number | null = null;
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const v = inbox.slice(from).find((x) => x.m.type === "version" && x.at >= finalAt);
      if (v) { settledAt = v.at; break; }
      // Idle counts from the FINAL partial: sentences whose last words draw nothing send no messages while
      // spoken, and measuring from the last message scored them before their settle job even started.
      if (running <= 0 && performance.now() - Math.max(finalAt, inbox.at(-1)?.at ?? 0) > 2500) break;
      await sleep(25);
    }
    const firstOp = inbox.slice(from).find((x) => x.m.type === "ops");
    last = { settleMs: settledAt ? Math.round(settledAt - finalAt) : null, firstOpMs: firstOp ? Math.round(firstOp.at - t0) : null, from };
    seq++;
    await sleep(150);
  }
  const jobs = inbox.slice(last.from).map((x) => x.m).filter((m): m is Extract<ServerMsg, { type: "job" }> => m.type === "job" && m.state !== "running");
  const modelJobs = jobs.filter((j) => (j.inputTokens ?? 0) > 0);
  const usd = modelJobs.reduce((s, j) => s + (j.inputTokens ?? 0) * 1e-6 + (j.outputTokens ?? 0) * 5e-6, 0);
  const s = score(doc!, view, c);
  if (process.env.CORPUS_DEBUG) console.log(c.id, inbox.map((x) => x.m.type === "ops" ? `ops:${x.m.origin}:${x.m.ops.length}` : x.m.type === "job" ? `job:${x.m.kind}:${x.m.state}${x.m.detail ? `(${x.m.detail})` : ""}` : x.m.type === "error" ? `error:${x.m.message}` : x.m.type).join(" "));
  ws.close();
  return { id: c.id, view: c.expect.view ?? c.view, pass: s.pass, ...(c.known ? { known: c.known } : {}), failures: s.failures, settleMs: last.settleMs, firstOpMs: last.firstOpMs,
    calls: modelJobs.length, jev: 0, usd, say: c.say };
}

const cases = CASES.filter((c) => !filter || filter.test(c.id));
const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, async () => {
  while (next < cases.length) {
    const c = cases[next++]!;
    let r: Result;
    try { r = await runCase(c); } catch (e) { r = { id: c.id, view: c.view, pass: false, failures: [`harness: ${(e as Error).message}`], settleMs: null, firstOpMs: null, calls: 0, jev: 0, usd: 0, say: c.say }; }
    results.push(r);
    console.log(`${r.pass ? "PASS" : r.known ? "KNOWN" : "FAIL"} ${r.id.padEnd(24)} settle ${String(r.settleMs ?? "—").padStart(5)} ms · ${r.calls} call${r.calls === 1 ? "" : "s"} · $${r.usd.toFixed(4)}${r.pass ? "" : ` — ${r.failures.join("; ")}`}`);
  }
}));

const counted = results.filter((r) => !r.known);
const byView = (v: View) => { const rs = counted.filter((r) => r.view === v); return `${rs.filter((r) => r.pass).length}/${rs.length}`; };
const settles = results.map((r) => r.settleMs).filter((x): x is number => x != null);
const summary = {
  date: new Date().toISOString().slice(0, 10), url, cases: results.length,
  pass: `${counted.filter((r) => r.pass).length}/${counted.length}`, passRate: +(counted.filter((r) => r.pass).length / Math.max(1, counted.length)).toFixed(3),
  byView: { screen: byView("screen"), architecture: byView("architecture"), erd: byView("erd"), sequence: byView("sequence") },
  known: results.filter((r) => r.known).map((r) => `${r.id}: ${r.pass ? "passed" : "failed"} (${r.known})`),
  settleP50: pct(settles, 50), settleP95: pct(settles, 95), settleOver1500: settles.filter((s) => s > 1500).length,
  modelCalls: results.reduce((s, r) => s + r.calls, 0), usd: +results.reduce((s, r) => s + r.usd, 0).toFixed(4),
};
console.log(`\nM7 corpus: ${summary.pass} passed (${Math.round(summary.passRate * 100)}%) · screen ${summary.byView.screen} · architecture ${summary.byView.architecture} · ERD ${summary.byView.erd} · sequence ${summary.byView.sequence}`);
console.log(`settle p50 ${summary.settleP50} ms · p95 ${summary.settleP95} ms · ${summary.settleOver1500} over 1,500 ms · ${summary.modelCalls} model calls · $${summary.usd}`);
if (summary.known.length) console.log(`known blind spots: ${summary.known.join(" · ")}`);
const out = resolve(import.meta.dirname, "../../docs/m7");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, `corpus-${summary.date}${filter ? "-partial" : ""}.json`), JSON.stringify({ summary, results: results.sort((a, b) => a.id.localeCompare(b.id)) }, null, 1));
if (summary.passRate < 0.9) process.exitCode = 1;
