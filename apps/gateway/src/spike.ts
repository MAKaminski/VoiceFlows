/**
 * M0 latency spike (ADR 0001). Measures the two hops we don't control, from wherever it runs
 * (Railway sfo as a one-off service, or a laptop for comparison):
 *   A. Deepgram Nova-3 streaming: word-end (audio clock) → first interim partial containing it
 *   B. Haiku 4.5 fused call: TTFT, header closed, first valid op closed — compact vs JSON Patch,
 *      keep-alive vs fresh connection; tokens, cache tokens, op validity; one Sonnet settle sample
 * Prints one human table and one `M0_RESULT {json}` line. Cost: ≈ $0.15 of API usage per run.
 */
import {
  applyOp, emptyDoc, expandCompact, findNode, PatchOp, serializeCompact,
  type CompactContext, type DesignDoc,
} from "@livecanvas/dsl";
import { loadPrompt } from "@livecanvas/prompts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, fetch as ufetch } from "undici";

const RUNS = Number(process.env.SPIKE_RUNS ?? 20);
const STT_RUNS = Number(process.env.SPIKE_STT_RUNS ?? 10);
const WAV = process.env.SPIKE_WAV ?? resolve(process.cwd(), "scripts/fixtures/dod.wav");
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const DEEPGRAM = process.env.DEEPGRAM_API_KEY;
const HAIKU = process.env.MODEL_PATCH_FAST ?? "claude-haiku-4-5-20251001";
const SONNET = process.env.MODEL_PATCH_STRUCTURAL ?? "claude-sonnet-5";
const WHERE = process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? process.env.SPIKE_WHERE ?? "local";

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const stat = (xs: number[]) => ({ n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── A. Deepgram ────────────────────────────────────────────────────────────────
function pcmFromWav(buf: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

const KEYWORDS = ["login", "email", "password", "big", "blue", "button", "logo", "top"];
const CONTENT = new Set([...KEYWORDS, "screen", "sign-in", "sign", "in"]);

async function deepgramRun(pcm: Buffer) {
  const url = "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&vad_events=true&endpointing=300&punctuate=false&smart_format=false";
  const ws = new WebSocket(url, ["token", DEEPGRAM!]);
  const firstSeen = new Map<string, { word: string; lagMs: number }>();
  const partialGaps: number[] = [];
  let lastPartialAt = 0;
  let t0 = 0;
  const openAt = performance.now();
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("deepgram ws error")); });
  const connectMs = performance.now() - openAt;
  const done = new Promise<void>((res) => { ws.onclose = () => res(); });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type !== "Results") return;
    const now = performance.now();
    if (lastPartialAt) partialGaps.push(now - lastPartialAt);
    lastPartialAt = now;
    const audioNowMs = now - t0;
    for (const w of msg.channel?.alternatives?.[0]?.words ?? []) {
      const key = `${String(w.word).toLowerCase()}@${Math.round(w.start * 5)}`;
      if (!firstSeen.has(key)) firstSeen.set(key, { word: String(w.word).toLowerCase(), lagMs: audioNowMs - w.end * 1000 });
    }
  };
  const FRAME = 640; // 20 ms at 16 kHz int16
  t0 = performance.now();
  for (let i = 0, n = 0; i < pcm.length; i += FRAME, n++) {
    ws.send(pcm.subarray(i, i + FRAME));
    const due = t0 + (n + 1) * 20;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
  }
  ws.send(JSON.stringify({ type: "CloseStream" }));
  await Promise.race([done, sleep(5000)]);
  const lags = [...firstSeen.values()];
  const contentEvents = lags.filter((w) => CONTENT.has(w.word)).length;
  return { connectMs, lags, partialGaps, contentEvents, audioSec: pcm.length / 32000 };
}

// ─── B. Model calls ─────────────────────────────────────────────────────────────
const fused = loadPrompt("fused_system");
const patch = loadPrompt("patch_system");

const SCENARIOS: Array<{ text: string; intent: object }> = [
  { text: "a login screen", intent: { action: "add", targets: [{ ref: "login screen", primitive: "Frame" }], attributes: {}, structural: true, explicit_command: false, confidence: 0.8 } },
  { text: "a login screen with email and password", intent: { action: "add", targets: [{ ref: "email", primitive: "Input" }, { ref: "password", primitive: "Input" }], attributes: {}, structural: false, explicit_command: false, confidence: 0.9 } },
  { text: "a login screen with email and password, big blue sign-in button", intent: { action: "add", targets: [{ ref: "sign-in", primitive: "Button" }], attributes: { size: "lg", color: "primary", label: "Sign in" }, structural: false, explicit_command: false, confidence: 0.9 } },
  { text: "a login screen with email and password, big blue sign-in button, logo on top", intent: { action: "add", targets: [{ ref: "logo", primitive: "Image" }], attributes: { position: "top" }, structural: false, explicit_command: false, confidence: 0.9 } },
];

/** Doc state the user would see when each scenario's partial arrives (earlier elements provisional). */
function docFor(i: number): DesignDoc {
  const d = emptyDoc();
  const kids = d.root.children!;
  if (i >= 2) kids.push({ id: "n_email", type: "Input", props: { label: "Email", kind: "email" } }, { id: "n_password", type: "Input", props: { label: "Password", kind: "password" } });
  if (i >= 3) kids.push({ id: "n_signin", type: "Button", props: { label: "Sign in", variant: "primary", size: "lg" }, provisional: true });
  return d;
}

interface CallResult { ttft: number; header: number; firstOp: number; total: number; inTok: number; outTok: number; cacheWrite: number; cacheRead: number; ops: number; validOps: number; firstOpValid: boolean }

const keepAlive = new Agent({ keepAliveTimeout: 60_000, connections: 4 });

async function callModel(model: string, format: "compact" | "jsonpatch", i: number, fresh: boolean): Promise<CallResult> {
  const doc = docFor(i);
  const sc = SCENARIOS[i]!;
  const system = format === "compact" ? fused.system : patch.system;
  const user = format === "compact"
    ? fused.render({ doc_compact: serializeCompact(doc.root) || "(empty frame: root)", partial_text: sc.text })
    : patch.render({ doc_json: JSON.stringify(doc), intent_json: JSON.stringify(sc.intent) });
  const dispatcher = fresh ? new Agent({ keepAliveTimeout: 1, connections: 1 }) : keepAlive;
  const t0 = performance.now();
  const res = await ufetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    dispatcher,
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 400, stream: true,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${await res.text()}`);

  const r: CallResult = { ttft: NaN, header: NaN, firstOp: NaN, total: NaN, inTok: 0, outTok: 0, cacheWrite: 0, cacheRead: 0, ops: 0, validOps: 0, firstOpValid: false };
  let text = "", raw = "", sse = "", lineNo = 0, working = structuredClone(doc);
  const aliases = new Map<string, string>();
  let n = 0;
  const ctx: CompactContext = {
    resolve: (ref) => (ref === "root" ? "/root" : findNode(working.root, aliases.get(ref) ?? ref)?.path ?? null),
    assignId: (alias) => { const id = `n_${alias.toLowerCase().replace(/[^a-z0-9]/g, "")}_${n++}`; aliases.set(alias, id); return id; },
  };
  const onLine = (line: string) => {
    const at = performance.now() - t0;
    const l = line.trim();
    if (!l || l.startsWith("```")) return;
    lineNo++;
    if (format === "compact" && lineNo === 1) { r.header = at; return; }
    r.ops++;
    let ok = false;
    try {
      const ops = format === "compact" ? expandCompact(l, ctx) : [PatchOp.parse(JSON.parse(l))];
      for (const op of ops) working = applyOp(working, format === "jsonpatch" ? rewriteNewIds(op) : op);
      ok = ops.length > 0;
    } catch { ok = false; }
    if (ok) r.validOps++;
    if (Number.isNaN(r.firstOp)) { r.firstOp = at; r.firstOpValid = ok; }
  };
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    sse += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx;
    while ((idx = sse.indexOf("\n\n")) >= 0) {
      const evt = sse.slice(0, idx); sse = sse.slice(idx + 2);
      const data = evt.split("\n").find((x) => x.startsWith("data: "))?.slice(6);
      if (!data) continue;
      const m = JSON.parse(data);
      if (m.type === "message_start") {
        const u = m.message.usage;
        r.inTok = u.input_tokens; r.cacheWrite = u.cache_creation_input_tokens ?? 0; r.cacheRead = u.cache_read_input_tokens ?? 0;
      } else if (m.type === "content_block_delta" && m.delta.type === "text_delta") {
        if (Number.isNaN(r.ttft)) r.ttft = performance.now() - t0;
        text += m.delta.text; raw += m.delta.text;
        let nl;
        while ((nl = text.indexOf("\n")) >= 0) { onLine(text.slice(0, nl)); text = text.slice(nl + 1); }
      } else if (m.type === "message_delta") {
        r.outTok = m.usage?.output_tokens ?? r.outTok;
      }
    }
  }
  if (text.trim()) onLine(text);
  if (process.env.SPIKE_DEBUG) console.log(`--- ${model} ${format} #${i}\n${raw}`);
  r.total = performance.now() - t0;
  if (fresh) await dispatcher.close();
  return r;
}

function rewriteNewIds(op: PatchOp): PatchOp {
  const fix = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/"\$new:([^"]+)"/g, (_, a: string) => `"n_${a.toLowerCase().replace(/[^a-z0-9]/g, "")}"`));
  return "value" in op ? ({ ...op, value: fix(op.value) } as PatchOp) : op;
}

// Published per-MTok prices, 2026-09-26 (docs/COST_MODEL.md).
const PRICE = { haiku: { in: 1, out: 5, write: 1.25, read: 0.1 }, sonnet: { in: 2, out: 10, write: 2.5, read: 0.2 } };
const dollars = (r: CallResult, p: typeof PRICE.haiku) => (r.inTok * p.in + r.outTok * p.out + r.cacheWrite * p.write + r.cacheRead * p.read) / 1e6;

async function main() {
  if (!ANTHROPIC || !DEEPGRAM) throw new Error("ANTHROPIC_API_KEY and DEEPGRAM_API_KEY are required");
  const out: Record<string, unknown> = { where: WHERE, at: new Date().toISOString(), runs: RUNS, sttRuns: STT_RUNS };
  console.log(`M0 spike from ${WHERE} — ${RUNS} model runs per cell, ${STT_RUNS} STT runs`);

  // A. Deepgram
  const pcm = pcmFromWav(readFileSync(WAV));
  const stt = { connect: [] as number[], lag: [] as number[], gaps: [] as number[], perKeyword: {} as Record<string, number[]>, contentPerMin: [] as number[] };
  for (let i = 0; i < STT_RUNS; i++) {
    const r = await deepgramRun(pcm);
    stt.connect.push(r.connectMs);
    stt.gaps.push(...r.partialGaps);
    for (const w of r.lags) {
      stt.lag.push(w.lagMs);
      if (KEYWORDS.includes(w.word)) (stt.perKeyword[w.word] ??= []).push(w.lagMs);
    }
    stt.contentPerMin.push((r.contentEvents / r.audioSec) * 60);
  }
  out.stt = {
    connectMs: stat(stt.connect), wordLagMs: stat(stt.lag), partialIntervalMs: stat(stt.gaps),
    keywordLagMsP50: Object.fromEntries(Object.entries(stt.perKeyword).map(([k, v]) => [k, Math.round(pct(v, 50))])),
    contentWordEventsPerSpeakingMin: Math.round(pct(stt.contentPerMin, 50)),
  };

  // B. Model cells
  const cells: Array<[string, string, "compact" | "jsonpatch", boolean, number]> = [
    ["haiku·compact·warm", HAIKU, "compact", false, RUNS],
    ["haiku·compact·fresh", HAIKU, "compact", true, RUNS],
    ["haiku·jsonpatch·warm", HAIKU, "jsonpatch", false, RUNS],
    ["haiku·jsonpatch·fresh", HAIKU, "jsonpatch", true, Math.ceil(RUNS / 2)],
    ["sonnet·compact·warm", SONNET, "compact", false, 5],
  ];
  await callModel(HAIKU, "compact", 0, false).catch(() => undefined); // open + warm the keep-alive socket
  const model: Record<string, unknown> = {};
  for (const [name, m, fmt, fresh, n] of cells) {
    const rs: CallResult[] = [];
    for (let i = 0; i < n; i++) rs.push(await callModel(m, fmt, i % SCENARIOS.length, fresh));
    const price = m === SONNET ? PRICE.sonnet : PRICE.haiku;
    model[name] = {
      ttftMs: stat(rs.map((r) => r.ttft).filter((x) => !Number.isNaN(x))),
      headerMs: fmt === "compact" ? stat(rs.map((r) => r.header).filter((x) => !Number.isNaN(x))) : null,
      firstOpMs: stat(rs.map((r) => r.firstOp).filter((x) => !Number.isNaN(x))),
      totalMs: stat(rs.map((r) => r.total)),
      inTokP50: Math.round(pct(rs.map((r) => r.inTok + r.cacheRead + r.cacheWrite), 50)),
      outTokP50: Math.round(pct(rs.map((r) => r.outTok), 50)),
      cacheWriteMax: Math.max(...rs.map((r) => r.cacheWrite)),
      cacheReadMax: Math.max(...rs.map((r) => r.cacheRead)),
      opValidity: rs.reduce((s, r) => s + r.validOps, 0) / Math.max(1, rs.reduce((s, r) => s + r.ops, 0)),
      firstOpValidRate: rs.filter((r) => r.firstOpValid).length / rs.length,
      dollarsPerCallP50: Number(pct(rs.map((r) => dollars(r, price)), 50).toFixed(5)),
    };
    const c = model[name] as any;
    console.log(`${name.padEnd(24)} TTFT p50 ${c.ttftMs.p50} · first op p50 ${c.firstOpMs.p50} p95 ${c.firstOpMs.p95} · in ${c.inTokP50} out ${c.outTokP50} · valid ${(c.opValidity * 100).toFixed(0)}% · cache w/r ${c.cacheWriteMax}/${c.cacheReadMax}`);
  }
  out.model = model;

  // C. Derived: TTFV and $/speaking-minute with measured inputs
  const s = out.stt as any;
  const hw = model["haiku·compact·warm"] as any;
  const sw = model["sonnet·compact·warm"] as any;
  const netMs = Number(process.env.SPIKE_CLIENT_NET_MS ?? 40), renderMs = 60, relayMs = 20, gapWaitMs = 75, pushMs = 30;
  const callsPerMin = Math.min(20, s.contentWordEventsPerSpeakingMin, Math.floor(60_000 / (150 + hw.totalMs.p50)));
  out.derived = {
    ttfv0MsP50: netMs + s.wordLagMs.p50 + 5 + renderMs,
    ttfv1MsP50: netMs + s.wordLagMs.p50 + relayMs + gapWaitMs + hw.firstOpMs.p50 + pushMs + renderMs,
    callsPerSpeakingMin: callsPerMin,
    dollarsPerSpeakingMin: Number((callsPerMin * hw.dollarsPerCallP50 + 1 * sw.dollarsPerCallP50 + 0.0077).toFixed(4)),
    assumptions: { netMs, renderMs, relayMs, gapWaitMs, pushMs, sonnetSettlesPerMin: 1, deepgramPerMin: 0.0077 },
  };
  console.log(`STT word lag p50 ${s.wordLagMs.p50} p95 ${s.wordLagMs.p95} · partial every ${s.partialIntervalMs.p50} ms · content-word events ${s.contentWordEventsPerSpeakingMin}/min`);
  console.log(`DERIVED TTFV-0 ${(out.derived as any).ttfv0MsP50} ms · TTFV-1 ${(out.derived as any).ttfv1MsP50} ms · ${callsPerMin} calls/min · $${(out.derived as any).dollarsPerSpeakingMin}/speaking min`);
  console.log(`M0_RESULT ${JSON.stringify(out)}`);
  await keepAlive.close();
}

main().catch((err) => { console.error("M0 spike failed:", err); process.exit(1); });
