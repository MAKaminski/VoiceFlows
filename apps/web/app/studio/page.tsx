"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { TranscriptStrip } from "@/components/TranscriptStrip";
import { gateway } from "@/lib/gateway";
import { startVoice } from "@/lib/voice/session";
import { useDoc } from "@/store/doc";
import { useVoice } from "@/store/voice";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

const MODE_LABEL = { direct: "Deepgram Flux · direct", relay: "Deepgram Flux · via gateway", webspeech: "Browser speech (dev)" } as const;

const pill = (bg: string, fg = "#fff"): CSSProperties => ({
  font: "inherit", fontWeight: 600, padding: "8px 16px", borderRadius: 999, cursor: "pointer",
  border: "1px solid var(--lc-chrome-border)", background: bg, color: fg,
});

export default function Studio() {
  const { doc, connected, version, canUndo, canRedo, job } = useDoc();
  const { status, detail, mode, setStatus, setMode, push, reset, countFrame } = useVoice();
  const session = useRef<{ stop(): void } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [connError, setConnError] = useState<string | null>(null);

  const start = useCallback(async () => {
    reset();
    try {
      session.current = await startVoice({ onStatus: setStatus, onMode: setMode, onTranscript: push, onFrame: countFrame });
    } catch (e) {
      setStatus("error", (e as Error).message);
    }
  }, [countFrame, push, reset, setMode, setStatus]);
  const stop = useCallback(() => { session.current?.stop(); session.current = null; }, []);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__lcVoice = useVoice; // E2E harness
    (window as unknown as Record<string, unknown>).__lcDoc = useDoc;
    gateway.connect().then(() => setConnError(null), (e: Error) => setConnError(e.message));
    if (new URLSearchParams(location.search).has("autostart")) void start();
    return () => session.current?.stop();
  }, [start]);

  // ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Y redo — ignored while typing in the prompt box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); gateway.send({ type: "undo" }); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); gateway.send({ type: "redo" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    gateway.send({ type: "prompt", text });
    setPrompt("");
  };

  const listening = status === "listening" || status === "connecting";
  const jobLabel = !job ? null
    : job.state === "running" ? `Building: “${job.text}”…`
    : job.state === "done" ? `Done: ${job.opCount ?? 0} change${job.opCount === 1 ? "" : "s"}${job.firstOpMs != null ? ` · first in ${Math.round(job.firstOpMs)} ms` : ""}`
    : job.state === "aborted" ? `Stopped (${job.detail ?? "superseded"})`
    : `Couldn't build that: ${job.detail ?? "error"}`;

  return (
    <main style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>LiveCanvas</strong>
        <button type="button" onClick={listening ? stop : start} data-testid="mic" style={pill(listening ? "#dc2626" : "#2563eb")}>
          {status === "connecting" ? "Connecting…" : listening ? "Stop listening" : "Start talking"}
        </button>
        <form onSubmit={submit} style={{ display: "flex", gap: 8, flex: "1 1 320px", minWidth: 0 }}>
          <label htmlFor="prompt" style={{ position: "absolute", left: -9999 }}>Describe a change</label>
          <input id="prompt" data-testid="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Or type it: add a login form"
            style={{ flex: 1, minWidth: 0, font: "inherit", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit" }} />
          <button type="submit" disabled={!connected || !prompt.trim()} style={{ ...pill("#0f172a"), opacity: connected && prompt.trim() ? 1 : 0.5 }}>Build</button>
        </form>
        <button type="button" data-testid="undo" onClick={() => gateway.send({ type: "undo" })} disabled={!canUndo} title="Undo (⌘Z)" style={{ ...pill("transparent", "inherit"), opacity: canUndo ? 1 : 0.4 }}>Undo</button>
        <button type="button" data-testid="redo" onClick={() => gateway.send({ type: "redo" })} disabled={!canRedo} title="Redo (⇧⌘Z)" style={{ ...pill("transparent", "inherit"), opacity: canRedo ? 1 : 0.4 }}>Redo</button>
      </header>
      <div style={{ padding: "6px 24px", fontSize: 13, opacity: 0.8, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span data-testid="status">{mode ? MODE_LABEL[mode] : "mic off"} · {status}{detail ? ` — ${detail}` : ""}</span>
        <span data-testid="conn">{connError ? `Gateway: ${connError}` : connected ? `Version ${version}` : "Connecting to gateway…"}</span>
        {jobLabel && <span data-testid="job">{jobLabel}</span>}
      </div>
      <div style={{ flex: 1 }}><Canvas doc={doc} /></div>
      <TranscriptStrip />
    </main>
  );
}
