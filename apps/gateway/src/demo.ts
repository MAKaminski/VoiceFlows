import type { DocKind } from "@livecanvas/dsl";

/**
 * The home-page voice demo (ADR 0021): a scripted conversation that builds a customer-support product. Each line
 * is spoken by a Deepgram Aura-2 voice (generated once per voice on first request and cached in memory — the
 * audio never goes into the public repo) and transcribed by Deepgram to get real word timings. The player sends
 * the SCRIPT's words (not the transcript's — "SendGrid" must stay SendGrid) at those timings, as STT partials,
 * through the real engine; scaffolding and the PRD fill in the rest.
 */
export interface DemoLine { view: DocKind; text: string; send?: false }
export const DEMO_SCRIPT: DemoLine[] = [
  { view: "screen", text: "Let's build a customer support desk. Start with a sign in screen with email and password, and a big blue sign in button." },
  { view: "architecture", text: "The web app calls an API, which writes to Postgres and sends email through SendGrid." },
  { view: "erd", text: "Customers have many cases, and each case belongs to an agent." },
  { view: "erd", text: "Approve." },
  { view: "sequence", text: "When a customer opens a case, the web app posts it to the API, the API saves it in Postgres and notifies the agent." },
  { view: "constraints", text: "At peak we expect five hundred cases an hour, and Postgres handles about two hundred writes a second." },
  { view: "cva", text: "Sign in is cheap and high value. AI routing is expensive but high value." },
  { view: "screen", text: "That's the support desk. Six views and a PRD, from one conversation.", send: false },
];
export const DEMO_VOICES = [
  { id: "thalia", label: "Thalia", model: "aura-2-thalia-en" },
  { id: "orion", label: "Orion", model: "aura-2-orion-en" },
  { id: "andromeda", label: "Andromeda", model: "aura-2-andromeda-en" },
] as const;
export type DemoVoice = (typeof DEMO_VOICES)[number]["id"];

export interface DemoWord { word: string; start: number; end: number }
export interface DemoManifestLine { n: number; view: DocKind; text: string; send: boolean; duration: number; words: DemoWord[] }
export interface DemoManifest { voice: DemoVoice; lines: DemoManifestLine[] }

const scriptWords = (t: string) => t.split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Script words with times. Transcript words are matched in order; where the counts differ (numbers, names the
 * recogniser splits), the script's words are spread over the clip in proportion to their length — still in sync
 * with the voice, never with different words.
 */
export function alignWords(script: string, heard: DemoWord[], duration: number): DemoWord[] {
  const words = scriptWords(script);
  if (heard.length === words.length && heard.every((h, i) => norm(h.word) === norm(words[i]!) || norm(words[i]!).startsWith(norm(h.word)))) {
    return words.map((w, i) => ({ word: w, start: heard[i]!.start, end: heard[i]!.end }));
  }
  const t0 = heard[0]?.start ?? 0.1, t1 = heard.at(-1)?.end ?? Math.max(0.5, duration - 0.1);
  const total = words.reduce((s, w) => s + w.length + 1, 0);
  let at = t0;
  return words.map((w) => { const len = ((w.length + 1) / total) * (t1 - t0); const x = { word: w, start: at, end: at + len }; at += len; return x; });
}

/** Generates (once) and caches a voice's clips and manifest. */
export function demoAudio(apiKey: string | undefined, log: (m: string) => void = () => {}) {
  const manifests = new Map<DemoVoice, Promise<DemoManifest>>();
  const clips = new Map<string, Buffer>(); // `${voice}:${n}` → mp3
  const build = async (voice: DemoVoice): Promise<DemoManifest> => {
    if (!apiKey) throw new Error("no Deepgram key");
    const model = DEMO_VOICES.find((v) => v.id === voice)!.model;
    const lines = await Promise.all(DEMO_SCRIPT.map(async (line, n): Promise<DemoManifestLine> => {
      const tts = await fetch(`https://api.deepgram.com/v1/speak?model=${model}`, {
        method: "POST", headers: { authorization: `Token ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ text: line.text }),
      });
      if (!tts.ok) throw new Error(`Aura ${tts.status}`);
      const mp3 = Buffer.from(await tts.arrayBuffer());
      clips.set(`${voice}:${n}`, mp3);
      const stt = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&words=true", {
        method: "POST", headers: { authorization: `Token ${apiKey}`, "content-type": "audio/mpeg" }, body: mp3,
      });
      const d = stt.ok ? ((await stt.json()) as { metadata?: { duration?: number }; results?: { channels?: Array<{ alternatives?: Array<{ words?: DemoWord[] }> }> } }) : {};
      const heard = d.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
      const duration = d.metadata?.duration ?? (heard.at(-1)?.end ?? 3) + 0.3;
      return { n, view: line.view, text: line.text, send: line.send !== false, duration, words: alignWords(line.text, heard, duration) };
    }));
    log(`demo: generated ${lines.length} clips for ${voice}`);
    return { voice, lines };
  };
  return {
    manifest(voice: DemoVoice) {
      let m = manifests.get(voice);
      if (!m) { m = build(voice); manifests.set(voice, m); m.catch(() => manifests.delete(voice)); } // a failure is retried next time
      return m;
    },
    clip: (voice: DemoVoice, n: number) => clips.get(`${voice}:${n}`) ?? null,
  };
}
