/**
 * M4 acceptance — no browser. Streams scripts/fixtures/dod.wav to the gateway exactly like the
 * browser relay (80 ms int16 frames, real time), records each frame's send time, and scores against
 * the ground-truth word ends (scripts/fixtures/dod.words.json):
 *   TTFV-0  lexicon op arrival − send time of the keyword's last audio   (target ≤ 400 ms p50)
 *   TTFV-1  first model op of each job − send time of its trigger word    (target ≤ 1,000 ms p50)
 *   settle  version arrival − send time of the last word ("top")          (target ≤ 1,200 ms)
 *   DoD     email + password visible before "button" finishes; final layout correct
 *   reflows per element (op-stream proxy: pushed down or re-parented)     (< 3)
 * Arrival times are network arrival; browser capture (+40 ms est.) and render (+16 ms est.) are
 * added in the "adjusted" figures. pnpm tsx scripts/e2e/voice-accept.mts wss://…/ws [runs]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import { applyOp, ServerMsg, type DesignDoc, type DesignNode } from "../../packages/dsl/src/index.js";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const RUNS = Number(process.argv[3] ?? 10);
const CAPTURE_MS = 40, RENDER_MS = 16;
/** ADR 0023: TTFV-1 net (after the transcript arrives) p50 + render must stay under this — measured baseline +15%. */
const TTFV1_NET_BAR = Number(process.env.TTFV1_NET_BAR ?? 50);
const root = resolve(import.meta.dirname, "../..");
const wav = readFileSync(resolve(root, "scripts/fixtures/dod.wav"));
const words: Array<{ word: string; end: number }> = JSON.parse(readFileSync(resolve(root, "scripts/fixtures/dod.words.json"), "utf8")).words;
const endOf = (w: string) => words.find((x) => x.word === w)!.end;
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pcm(buf: Buffer) {
  let off = 12;
  while (off + 8 <= buf.length) { const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4); if (id === "data") return buf.subarray(off + 8, off + 8 + size); off += 8 + size + (size % 2); }
  throw new Error("no data chunk");
}
const audio = pcm(wav);
const FRAME = 2560; // 80 ms

const KEYWORD_KIND: Record<string, (n: DesignNode) => boolean> = {
  email: (n) => n.type === "Input" && n.props.kind === "email",
  password: (n) => n.type === "Input" && n.props.kind === "password",
  button: (n) => n.type === "Button",
  logo: (n) => n.type === "Image",
};

async function run(i: number) {
  const ws = new WebSocket(url);
  const inbox: Array<{ m: ServerMsg; at: number }> = [];
  let doc: DesignDoc | null = null;
  const moves = new Map<string, number>();
  const lexArrival: Record<string, number> = {};
  ws.on("message", (d) => {
    const at = performance.now();
    const m = ServerMsg.parse(JSON.parse(d.toString()));
    if (m.type === "doc") doc = m.doc;
    if (m.type === "ops" && doc) {
      const pos = (dd: DesignDoc) => { const map = new Map<string, string>(); const walk = (n: DesignNode, parent: string) => n.children?.forEach((c, k) => { map.set(c.id, `${parent}:${k}`); walk(c, c.id); }); walk(dd.root, "root"); return map; };
      const before = pos(doc);
      for (const op of m.ops) doc = applyOp(doc, op);
      const after = pos(doc);
      // Reflow proxy: an existing node pushed down (higher index) or moved to another parent. Whole-root
      // restores (undo/rollback) are not reflows of the user's utterance.
      // (A view restore is `replace /root/children/<i>` since projects, ADR 0016.)
      if (!(m.ops.length === 1 && m.ops[0]!.op === "replace" && /^\/root(\/children\/\d)?$/.test(m.ops[0]!.path))) {
        for (const [id, p] of after) {
          const b = before.get(id);
          if (!b) continue;
          const [bp, bi] = b.split(":"), [ap, ai] = p.split(":");
          if (bp !== ap || Number(ai) > Number(bi)) moves.set(id, (moves.get(id) ?? 0) + 1);
        }
      }
      if (m.origin === "lexicon") {
        const walk = (n: DesignNode) => { for (const [k, test] of Object.entries(KEYWORD_KIND)) if (lexArrival[k] == null && test(n)) lexArrival[k] = at; n.children?.forEach(walk); };
        walk(doc.root);
      }
    }
    inbox.push({ m, at });
  });
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello", ...(process.env.LC_ACCESS ? { access: process.env.LC_ACCESS } : {}) }));
  for (let k = 0; k < 100 && !doc; k++) await sleep(20);
  ws.send(JSON.stringify({ type: "stt_start", mode: "relay" }));
  await sleep(300); // relay opens Flux

  const sendAt: number[] = [];
  const t0 = performance.now();
  const silence = Buffer.alloc(FRAME);
  const total = Math.ceil(audio.length / FRAME) + 25; // + 2 s of silence so Flux ends the turn
  for (let f = 0; f < total; f++) {
    const chunk = f * FRAME < audio.length ? audio.subarray(f * FRAME, (f + 1) * FRAME) : silence;
    sendAt.push(performance.now());
    ws.send(chunk.length === FRAME ? chunk : Buffer.concat([chunk, Buffer.alloc(FRAME - chunk.length)]));
    const wait = t0 + (f + 1) * 80 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  const wallOf = (audioMs: number) => sendAt[Math.min(sendAt.length - 1, Math.floor(audioMs / 80))]! + (audioMs % 80);
  for (let k = 0; k < 150 && !inbox.some((x) => x.m.type === "version" && x.m.version > 0); k++) await sleep(20);
  await sleep(300);
  ws.send(JSON.stringify({ type: "stt_stop" }));
  ws.close();

  // TTFV-0 per keyword
  const ttfv0: Record<string, number> = {};
  for (const k of Object.keys(KEYWORD_KIND)) if (lexArrival[k] != null) ttfv0[k] = Math.round(lexArrival[k]! - wallOf(endOf(k)));
  // TTFV-1 per model job: first model ops batch − its trigger word
  const firstModel = new Map<string, { at: number; trig?: number }>();
  for (const { m, at } of inbox) if (m.type === "ops" && (m.origin === "model" || m.origin === "jev") && !firstModel.has(m.jobId)) firstModel.set(m.jobId, { at, trig: m.trigMs });
  const ttfv1 = [...firstModel.values()].filter((x) => x.trig != null).map((x) => Math.round(x.at - wallOf(x.trig!)));
  // Attribution: STT lag (transcript arrival − its newest word's audio end) vs everything after it.
  const sttLag = inbox.flatMap(({ m, at }) => (m.type === "transcript" && m.lastWordEndMs != null ? [Math.round(at - wallOf(m.lastWordEndMs))] : []));
  if (sttLag.length) console.log(`   stt lag p50 ${pct(sttLag, 50)} ms (n=${sttLag.length})`);
  // TTFV-1 NET (ADR 0023): first model-quality op − arrival of the transcript that delivered its trigger word.
  // Deepgram's lag is measured and reported separately (sttLag); the bar applies to what we control.
  const heardAt = (trig: number) => inbox.find(({ m }) => m.type === "transcript" && m.lastWordEndMs != null && m.lastWordEndMs >= trig - 1)?.at;
  const ttfv1Net = [...firstModel.values()].flatMap((x) => { const h = x.trig != null ? heardAt(x.trig) : undefined; return h != null ? [Math.round(x.at - h)] : []; });
  const version = inbox.find((x) => x.m.type === "version" && x.m.version > 0);
  // One version per utterance (ADR 0010): an early end-of-turn that commits mid-sentence splits it.
  const versions = new Set(inbox.flatMap((x) => (x.m.type === "version" && x.m.version > 0 ? [x.m.version] : []))).size;
  const settle = version ? Math.round(version.at - wallOf(endOf("top"))) : NaN;
  const jobs = inbox.filter((x) => x.m.type === "job" && x.m.state === "running").map((x) => (x.m as { kind?: string }).kind);
  const tokens = inbox.filter((x) => x.m.type === "job" && (x.m as { inputTokens?: number }).inputTokens != null)
    .reduce((a, x) => { const j = x.m as { inputTokens: number; outputTokens?: number }; return { in: a.in + j.inputTokens, out: a.out + (j.outputTokens ?? 0) }; }, { in: 0, out: 0 });
  const root = (doc as DesignDoc | null)?.root;
  const kids = (root?.type === "Project" ? root.children![0]!.children : root?.children) ?? []; // the screen view
  const has = (f: (n: DesignNode) => boolean) => { let ok = false; const w = (n: DesignNode) => { if (f(n)) ok = true; n.children?.forEach(w); }; kids.forEach(w); return ok; };
  const anyProvisional = (() => { let p = false; const w = (n: DesignNode) => { if (n.provisional) p = true; n.children?.forEach(w); }; kids.forEach(w); return p; })();
  if (process.env.SHOW_LAYOUT) console.log("LAYOUT", JSON.stringify(kids.map((n) => [n.id, n.type, n.props.label ?? n.props.alt ?? n.props.content, n.props.size, !!n.provisional])));
  const layoutOk = kids[0]?.type === "Image" && has(KEYWORD_KIND.email!) && has(KEYWORD_KIND.password!)
    && has((n) => n.type === "Button" && /sign/i.test(String(n.props.label)) && n.props.size === "lg") && !anyProvisional;
  const formBeforeButtonEnds = lexArrival.email != null && lexArrival.password != null && Math.max(lexArrival.email, lexArrival.password) < wallOf(endOf("button"));
  const maxReflows = Math.max(0, ...moves.values());
  const t0med = pct(Object.values(ttfv0), 50), t1med = pct(ttfv1, 50), t1net = pct(ttfv1Net, 50);
  const pass = versions === 1 && layoutOk && formBeforeButtonEnds && maxReflows < 3
    && t0med + CAPTURE_MS + RENDER_MS <= 400 && (Number.isNaN(t1med) || t1med + CAPTURE_MS + RENDER_MS <= 1000) && (Number.isNaN(t1net) || t1net + RENDER_MS <= TTFV1_NET_BAR) && settle + CAPTURE_MS + RENDER_MS <= 1200;
  const dollars = (tokens.in * 1 + tokens.out * 5) / 1e6;
  console.log(`run ${String(i + 1).padStart(2)}: ${pass ? "PASS" : "fail"} · TTFV-0 ${JSON.stringify(ttfv0)} · TTFV-1 [${ttfv1.join(", ")}] net [${ttfv1Net.join(", ")}] · settle ${settle} · versions ${versions} · reflows ${maxReflows} · form-before-button ${formBeforeButtonEnds} · layout ${layoutOk} · calls ${jobs.join("/")} · $${dollars.toFixed(4)}`);
  if (process.env.TIMELINE) {
    const topWall = wallOf(endOf("top"));
    for (const { m, at } of inbox) {
      const t = Math.round(at - topWall);
      if (m.type === "transcript" && (m.isFinal || m.eager || /top/.test(m.text))) console.log(`   ${String(t).padStart(6)} transcript${m.isFinal ? " FINAL" : ""}${m.eager ? " EAGER" : ""} "${m.text}" (word end ${m.lastWordEndMs})`);
      if (m.type === "job") console.log(`   ${String(t).padStart(6)} job ${m.kind} ${m.state}${m.firstOpMs != null ? ` firstOp ${Math.round(m.firstOpMs)}` : ""}${m.detail ? ` (${m.detail})` : ""}${m.text ? ` "${m.text}"` : ""}`);
      if (m.type === "version") console.log(`   ${String(t).padStart(6)} version ${m.version}`);
    }
  }
  if (!layoutOk) console.log(`        layout: ${kids.map((n) => `${n.type}${n.props.label ? `(${n.props.label})` : n.props.kind ? `(${n.props.kind})` : ""}${n.provisional ? "*" : ""}${n.children?.length ? `[${n.children.map((c) => c.type).join(",")}]` : ""}`).join(" · ")}`);
  return { pass, ttfv0, ttfv1, ttfv1Net, sttLagP50: pct(sttLag, 50), settle, maxReflows, formBeforeButtonEnds, layoutOk, calls: jobs.length, dollars, audioSec: total * 0.08 };
}

const rs = [];
for (let i = 0; i < RUNS; i++) { rs.push(await run(i)); await sleep(500); }
const all0 = rs.flatMap((r) => Object.values(r.ttfv0)), all1 = rs.flatMap((r) => r.ttfv1), all1n = rs.flatMap((r) => r.ttfv1Net), lags = rs.map((r) => r.sttLagP50).filter((x) => !Number.isNaN(x)), st = rs.map((r) => r.settle).filter((x) => !Number.isNaN(x));
const speakingMin = rs.reduce((a, r) => a + 6.23, 0) / 60;
const summary = {
  url, at: new Date().toISOString(), runs: RUNS, passes: rs.filter((r) => r.pass).length,
  ttfv0: { p50: pct(all0, 50), p95: pct(all0, 95), adjustedP50: pct(all0, 50) + CAPTURE_MS + RENDER_MS },
  ttfv1: { p50: pct(all1, 50), p95: pct(all1, 95), adjustedP50: pct(all1, 50) + CAPTURE_MS + RENDER_MS },
  ttfv1Net: { p50: pct(all1n, 50), p95: pct(all1n, 95), adjustedP50: pct(all1n, 50) + RENDER_MS, bar: TTFV1_NET_BAR },
  sttLag: { p50: pct(lags, 50), max: Math.max(...lags) },
  settle: { p50: pct(st, 50), p95: pct(st, 95), adjustedP50: pct(st, 50) + CAPTURE_MS + RENDER_MS },
  maxReflowsPerElement: Math.max(...rs.map((r) => r.maxReflows)),
  callsPerSpeakingMin: +(rs.reduce((a, r) => a + r.calls, 0) / speakingMin).toFixed(1),
  dollarsPerSpeakingMin: +(rs.reduce((a, r) => a + r.dollars, 0) / speakingMin).toFixed(4),
  assumptions: { captureMs: CAPTURE_MS, renderMs: RENDER_MS },
  perRun: rs,
};
console.log(`\nM4: ${summary.passes}/${RUNS} runs pass (need 8) · TTFV-0 p50 ${summary.ttfv0.p50} (+56 → ${summary.ttfv0.adjustedP50}) · TTFV-1 p50 ${summary.ttfv1.p50} (+56 → ${summary.ttfv1.adjustedP50}) · TTFV-1 net p50 ${summary.ttfv1Net.p50} (+16 → ${summary.ttfv1Net.adjustedP50}, bar ${TTFV1_NET_BAR}) · STT lag p50 ${summary.sttLag.p50} · settle p50 ${summary.settle.p50} · max reflows ${summary.maxReflowsPerElement} · ${summary.callsPerSpeakingMin} calls/min · $${summary.dollarsPerSpeakingMin}/min`);
console.log(`ACCEPT_RESULT ${JSON.stringify(summary)}`);
