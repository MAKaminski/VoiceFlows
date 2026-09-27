/**
 * M2 STT bake-off (ADR 0006). Streams scripts/fixtures/dod.wav in real time (20 ms frames) to each
 * provider and scores every provider the same way: for each reference word, lag = wall time the
 * word first appears in the provider's running transcript − the word's ground-truth end
 * (scripts/fixtures/dod.words.json). Pass bar: word lag ≤ 295 ms p50 at ≤ $0.0077/min.
 *   BAKEOFF_PROVIDERS=deepgram-nova3,deepgram-flux BAKEOFF_RUNS=10 node dist/bakeoff.js
 * Prints a table and one `BAKEOFF_RESULT {json}` line. Providers whose key is missing are skipped.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROVIDERS, type SttProvider } from "./providers.js";

const RUNS = Number(process.env.BAKEOFF_RUNS ?? 10);
const WAV = process.env.SPIKE_WAV ?? resolve(process.cwd(), "scripts/fixtures/dod.wav");
const WORDS = process.env.BAKEOFF_WORDS ?? resolve(process.cwd(), "scripts/fixtures/dod.words.json");
const WHERE = process.env.SPIKE_WHERE ?? process.env.RAILWAY_REPLICA_REGION ?? "local";
const PASS_LAG_MS = 295;
const PASS_PRICE = 0.0077;
const KEYWORDS = ["login", "email", "password", "big", "blue", "button", "logo", "top"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const tokens = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

export function pcmFromWav(buf: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}

interface Ref { word: string; end: number }

/** Streams once and returns per-reference-word first-seen lag (NaN = never seen). */
async function runOnce(p: SttProvider, pcm: Buffer, ref: Ref[]) {
  const connectAt = performance.now();
  const s = await p.connect();
  const connectMs = performance.now() - connectAt;
  const firstSeen: number[] = ref.map(() => NaN);
  const eventTimes: number[] = [];
  let committed = "";
  let t0 = 0;
  s.onText((text, isFinal) => {
    const now = performance.now() - t0;
    eventTimes.push(now);
    const running = `${committed} ${text}`;
    if (isFinal) committed = running;
    const toks = tokens(running);
    let from = 0;
    ref.forEach((r, i) => {
      const at = toks.indexOf(r.word, from);
      if (at >= 0) { from = at + 1; if (Number.isNaN(firstSeen[i])) firstSeen[i] = now; }
    });
  });
  const FRAME = 640; // 20 ms of 16 kHz int16
  t0 = performance.now();
  for (let i = 0, n = 0; i < pcm.length; i += FRAME, n++) {
    s.send(pcm.subarray(i, i + FRAME));
    const wait = t0 + (n + 1) * 20 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  // 1.5 s of trailing silence lets streaming models flush without an explicit finalize.
  const silence = Buffer.alloc(FRAME);
  for (let n = 0; n < 75; n++) { s.send(silence); await sleep(20); }
  await s.finish();
  const gaps = eventTimes.slice(1).map((t, i) => t - eventTimes[i]!);
  return { connectMs, lags: firstSeen.map((t, i) => t - ref[i]!.end), gaps };
}

async function main() {
  const pcm = pcmFromWav(readFileSync(WAV));
  // Normalize reference words exactly like transcripts ("sign-in" → "sign", "in").
  const ref: Ref[] = (JSON.parse(readFileSync(WORDS, "utf8")).words as Ref[]).flatMap((w) => tokens(w.word).map((t) => ({ word: t, end: w.end })));
  const wanted = (process.env.BAKEOFF_PROVIDERS ?? Object.keys(PROVIDERS).join(",")).split(",").map((x) => x.trim());
  const results: Record<string, unknown> = {};
  console.log(`STT bake-off from ${WHERE} — ${RUNS} runs × ${ref.length} words; pass = p50 ≤ ${PASS_LAG_MS} ms at ≤ $${PASS_PRICE}/min`);
  for (const name of wanted) {
    const p = PROVIDERS[name];
    if (!p) { console.log(`${name}: unknown provider`); continue; }
    if (!p.ready()) { console.log(`${name.padEnd(22)} skipped — ${p.needs}`); results[name] = { skipped: p.needs }; continue; }
    const lags: number[] = [], kw: Record<string, number[]> = {}, gaps: number[] = [], connect: number[] = [];
    let misses = 0, errors = 0;
    const missedWords: Record<string, number> = {}, perWord: Record<string, number[]> = {};
    for (let r = 0; r < RUNS; r++) {
      try {
        const o = await runOnce(p, pcm, ref);
        connect.push(o.connectMs); gaps.push(...o.gaps);
        o.lags.forEach((l, i) => {
          const w = ref[i]!.word;
          if (Number.isNaN(l)) { misses++; missedWords[w] = (missedWords[w] ?? 0) + 1; return; }
          lags.push(l);
          (perWord[`${i}:${w}`] ??= []).push(l);
          if (KEYWORDS.includes(w)) (kw[w] ??= []).push(l);
        });
      } catch (e) { errors++; console.log(`  ${name} run ${r + 1} error: ${(e as Error).message}`); }
    }
    const p50 = Math.round(pct(lags, 50));
    const res = {
      pricePerMin: p.pricePerMin,
      wordLagMs: { n: lags.length, p50, p95: Math.round(pct(lags, 95)), min: Math.round(Math.min(...lags)) },
      keywordLagP50: Object.fromEntries(Object.entries(kw).map(([k, v]) => [k, Math.round(pct(v, 50))])),
      eventIntervalMsP50: Math.round(pct(gaps, 50)),
      connectMsP50: Math.round(pct(connect, 50)),
      wordRecall: lags.length / Math.max(1, lags.length + misses),
      missedWords,
      perWordLagP50: Object.fromEntries(Object.entries(perWord).map(([k, v]) => [k, Math.round(pct(v, 50))])),
      negativeLagShare: lags.filter((l) => l < 0).length / Math.max(1, lags.length),
      errors,
      pass: p50 <= PASS_LAG_MS && p.pricePerMin <= PASS_PRICE && errors === 0,
    };
    results[name] = res;
    console.log(`${name.padEnd(22)} lag p50 ${String(p50).padStart(4)} p95 ${String(res.wordLagMs.p95).padStart(4)} · events every ${res.eventIntervalMsP50} ms · recall ${(res.wordRecall * 100).toFixed(0)}% · $${p.pricePerMin}/min · ${res.pass ? "PASS" : "fail"}`);
  }
  console.log(`BAKEOFF_RESULT ${JSON.stringify({ where: WHERE, at: new Date().toISOString(), runs: RUNS, results })}`);
}

main().catch((e) => { console.error("bake-off failed:", e); process.exit(1); });
