"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { TranscriptStrip } from "@/components/TranscriptStrip";
import { startVoice } from "@/lib/voice/session";
import { useDoc } from "@/store/doc";
import { useVoice } from "@/store/voice";
import { emptyDoc } from "@livecanvas/dsl";
import { useCallback, useEffect, useRef } from "react";

const MODE_LABEL = { direct: "Deepgram Flux · direct", relay: "Deepgram Flux · via gateway", webspeech: "Browser speech (dev)" } as const;

export default function Studio() {
  const { doc, setDoc } = useDoc();
  const { status, detail, mode, setStatus, setMode, push, reset, countFrame } = useVoice();
  const session = useRef<{ stop(): void } | null>(null);

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
    setDoc(emptyDoc("studio"));
    (window as unknown as { __lcVoice: typeof useVoice }).__lcVoice = useVoice; // E2E latency harness
    if (new URLSearchParams(location.search).has("autostart")) void start();
    return () => session.current?.stop();
  }, [setDoc, start]);

  const listening = status === "listening" || status === "connecting";
  return (
    <main style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <strong>LiveCanvas</strong>
        <button type="button" onClick={listening ? stop : start} data-testid="mic"
          style={{ font: "inherit", fontWeight: 600, padding: "8px 16px", borderRadius: 999, cursor: "pointer",
            border: "1px solid var(--lc-chrome-border)", background: listening ? "#dc2626" : "#2563eb", color: "#fff" }}>
          {status === "connecting" ? "Connecting…" : listening ? "Stop listening" : "Start talking"}
        </button>
        <span data-testid="status" style={{ fontSize: 13, opacity: 0.75 }}>
          {mode ? MODE_LABEL[mode] : "not connected"} · {status}{detail ? ` — ${detail}` : ""}
        </span>
      </header>
      <div style={{ flex: 1 }}><Canvas doc={doc} /></div>
      <TranscriptStrip />
    </main>
  );
}
