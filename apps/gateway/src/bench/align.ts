/**
 * One-off: derive the ground-truth word alignment of scripts/fixtures/dod.wav from Deepgram
 * *final* results (Nova-3, batch-quality timestamps). Every bake-off provider is scored against
 * this file, so providers without word timestamps (Web Speech) are measured the same way.
 *   DEEPGRAM_API_KEY=… node dist/align.js   (writes scripts/fixtures/dod.words.json)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const WAV = process.env.SPIKE_WAV ?? resolve(process.cwd(), "scripts/fixtures/dod.wav");
const key = process.env.DEEPGRAM_API_KEY;
if (!key) throw new Error("DEEPGRAM_API_KEY is required");

const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&punctuate=false&smart_format=false", {
  method: "POST",
  headers: { authorization: `Token ${key}`, "content-type": "audio/wav" },
  body: readFileSync(WAV),
});
if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);
const body = (await res.json()) as any;
const words = body.results.channels[0].alternatives[0].words.map((w: any) => ({
  word: String(w.word).toLowerCase(), start: Math.round(w.start * 1000), end: Math.round(w.end * 1000),
}));
const out = process.env.ALIGN_OUT ?? resolve(process.cwd(), "scripts/fixtures/dod.words.json");
writeFileSync(out, JSON.stringify({ source: "deepgram nova-3 prerecorded, 2026-09-26", audioMs: 6235, words }, null, 1) + "\n");
console.log(`wrote ${words.length} words to ${out}`);
