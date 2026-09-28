"use client";
import { BuildDrawer } from "@/components/BuildDrawer";
import { PrdDrawer } from "@/components/PrdDrawer";
import { ViewGrid } from "@/components/ViewGrid";
import { demoGateway, HTTP_BASE } from "@/lib/gateway";
import { useDoc } from "@/store/doc";
import type { DocKind } from "@livecanvas/dsl";
import { useEffect, useRef, useState } from "react";

/**
 * The narrated demo (ADR 0021). An AI voice (Deepgram Aura-2) talks through building a support desk; the page
 * feeds the script's words to the REAL engine at the voice's word timings — the same `partial` path the
 * browser's own speech-to-text uses — so every view, the scaffolding and the PRD are drawn live, not replayed.
 * Demo scope at the gateway: fresh in-memory document, capped calls, nothing saved.
 */
interface Word { word: string; start: number; end: number }
interface Line { n: number; view: DocKind; text: string; send: boolean; duration: number; words: Word[] }
interface Manifest { voice: string; voices: Array<{ id: string; label: string }>; lines: Line[] }
type Phase = "idle" | "loading" | "playing" | "done" | "busy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Demo() {
  const { doc: project, view } = useDoc();
  const [voice, setVoice] = useState("thalia");
  const [voices, setVoices] = useState<Manifest["voices"]>([{ id: "thalia", label: "Thalia" }, { id: "orion", label: "Orion" }, { id: "andromeda", label: "Andromeda" }]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [line, setLine] = useState<{ n: number; text: string; spoken: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState(false); // ADR 0022: the demo ends with the code
  const stop = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const off = demoGateway.on((m) => {
      if (m.type === "error" && /demo/i.test(m.message)) { stop.current = true; setPhase("busy"); setError(m.message); }
    });
    return () => { off(); stop.current = true; audio.current?.pause(); };
  }, []);

  const play = async () => {
    stop.current = false;
    setError(null);
    setPhase("loading");
    const r = await fetch(`${HTTP_BASE}/demo/manifest?voice=${voice}`).catch(() => null);
    if (!r?.ok) { setPhase("busy"); setError("The demo voice is warming up — try again in a moment."); return; }
    const m = (await r.json()) as Manifest;
    setVoices(m.voices);
    try { await demoGateway.connect(); } catch { setPhase("busy"); setError("Demo busy — try again in a minute."); return; }
    demoGateway.send({ type: "stt_start", mode: "direct" });
    demoGateway.send({ type: "set_title", title: "Support desk" });
    demoGateway.send({ type: "ui_event", feature: "voice_demo", action: "used" });
    setPhase("playing");
    const t0 = performance.now();
    let seq = 0;
    for (const l of m.lines) {
      if (stop.current) return;
      if (l.send) demoGateway.send({ type: "set_view", view: l.view });
      const el = new Audio(`${HTTP_BASE}/demo/audio/${m.voice}/${l.n}`);
      audio.current = el;
      setLine({ n: l.n, text: l.text, spoken: 0 });
      const s = seq;
      await new Promise<void>((resolve) => {
        let i = 0;
        let raf = 0;
        const tick = () => {
          if (stop.current) { el.pause(); resolve(); return; }
          const at = el.currentTime;
          let moved = false;
          while (i < l.words.length && l.words[i]!.start <= at) { i++; moved = true; }
          if (moved) {
            setLine({ n: l.n, text: l.text, spoken: i });
            if (l.send) demoGateway.send({ type: "partial", utteranceSeq: s, text: l.words.slice(0, i).map((w) => w.word).join(" "), isFinal: false, tMs: performance.now() - t0, lastWordEndMs: l.words[i - 1]!.end * 1000 });
          }
          raf = requestAnimationFrame(tick);
        };
        el.onended = () => { cancelAnimationFrame(raf); resolve(); };
        el.onerror = () => { cancelAnimationFrame(raf); resolve(); };
        el.play().then(() => { raf = requestAnimationFrame(tick); }).catch(() => resolve());
      });
      if (stop.current) return;
      setLine({ n: l.n, text: l.text, spoken: l.words.length });
      if (l.send) {
        demoGateway.send({ type: "partial", utteranceSeq: s, text: l.text, isFinal: true, eager: true, tMs: performance.now() - t0 });
        seq++;
        await sleep(900); // the sentence settles (~0.7 s) before the next voice line — like a person pausing
      }
    }
    setPhase("done");
  };

  const pause = () => { stop.current = true; audio.current?.pause(); setPhase("idle"); };
  const btn = { font: "inherit", fontSize: 15, fontWeight: 650, padding: "10px 20px", borderRadius: 999, border: "none", cursor: "pointer" } as const;
  const words = line?.text.split(/\s+/) ?? [];

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--lc-chrome-bg)", color: "var(--lc-chrome-fg)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 20px", borderBottom: "1px solid var(--lc-chrome-border)", flexWrap: "wrap" }}>
        <a href="/" style={{ fontWeight: 700, color: "inherit", textDecoration: "none" }}>LiveCanvas</a>
        <span style={{ opacity: 0.6, fontSize: 14 }}>Demo — a support desk, spoken into existence</span>
        <label style={{ marginLeft: "auto", fontSize: 14, display: "flex", gap: 6, alignItems: "center" }}>
          Voice
          <select data-testid="demo-voice" value={voice} disabled={phase === "playing" || phase === "loading"} onChange={(e) => setVoice(e.target.value)}
            style={{ font: "inherit", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit" }}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </label>
        {phase === "playing" || phase === "loading"
          ? <button type="button" data-testid="demo-stop" onClick={pause} style={{ ...btn, background: "#e2e8f0", color: "#0f172a" }}>{phase === "loading" ? "Loading…" : "Stop"}</button>
          : <button type="button" data-testid="demo-play" onClick={() => (phase === "idle" && !line ? play() : location.reload())} style={{ ...btn, background: "#2563eb", color: "#fff" }}>
              {phase === "idle" && !line ? "▶ Play" : "↻ Restart"}
            </button>}
        {phase === "done" && <button type="button" data-testid="demo-build" onClick={() => setBuild((b) => !b)} style={{ ...btn, background: "#16a34a", color: "#fff" }}>{build ? "Show PRD" : "</> Build it"}</button>}
        <a href="/#join" style={{ ...btn, background: "#0f172a", color: "#fff", textDecoration: "none" }}>Get an invite</a>
      </header>

      <div data-testid="demo-caption" aria-live="polite" style={{ padding: "14px 20px", minHeight: 58, fontSize: 20, lineHeight: 1.4, borderBottom: "1px solid var(--lc-chrome-border)" }}>
        {error ? <span role="alert" style={{ color: "#b45309" }}>{error}</span>
          : line ? words.map((w, i) => <span key={i} style={{ opacity: i < line.spoken ? 1 : 0.3, transition: "opacity .12s" }}>{w} </span>)
          : <span style={{ opacity: 0.6 }}>Press play: a voice describes a product, and all six views and the PRD build as it talks.</span>}
      </div>

      <div style={{ flex: 1, display: "flex", flexWrap: "wrap", minHeight: 0 }}>
        <div style={{ flex: "1 1 640px", display: "flex", minWidth: 0 }}>
          {project.root.type === "Project" && <ViewGrid project={project} active={phase === "playing" ? view : null} readOnly />}
        </div>
        {project.root.type === "Project" && (build ? <BuildDrawer project={project} onClose={() => setBuild(false)} demo /> : <PrdDrawer project={project} onClose={() => {}} standalone />)}
      </div>
    </main>
  );
}
