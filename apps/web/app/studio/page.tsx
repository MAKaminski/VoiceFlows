"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { Hud } from "@/components/Hud";
import { TranscriptStrip } from "@/components/TranscriptStrip";
import { currentMaxReflows, installMetricsTap } from "@/lib/metricsTap";
import { useMetrics } from "@/store/metrics";
import { gateway } from "@/lib/gateway";
import { startVoice } from "@/lib/voice/session";
import { useDoc } from "@/store/doc";
import { useVoice } from "@/store/voice";
import { KeywordRail } from "@/components/KeywordRail";
import { SharePopover } from "@/components/SharePopover";
import { useFeatures } from "@/store/features";
import { docKind, kindFeature, type DocKind } from "@livecanvas/dsl";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

const KINDS: Array<{ kind: DocKind; label: string }> = [
  { kind: "screen", label: "Screen" }, { kind: "architecture", label: "Architecture" }, { kind: "erd", label: "ERD" }, { kind: "sequence", label: "Sequence" },
];

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
  const [hud, setHud] = useState(false);

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
    (window as unknown as Record<string, unknown>).__lcMetrics = useMetrics;
    (window as unknown as Record<string, unknown>).__lcReflowNow = currentMaxReflows;
    const untap = installMetricsTap();
    setHud(new URLSearchParams(location.search).has("hud"));
    gateway.connect().then(() => setConnError(null), (e: Error) => setConnError(e.message));
    if (new URLSearchParams(location.search).has("autostart")) void start();
    return () => { untap(); session.current?.stop(); };
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
  const kind = docKind(doc);
  const { flags, notice } = useFeatures();
  const canCreate = flags.speak_to_create;
  const jobLabel = !job ? null
    : job.state === "running" ? `Building: “${job.text}”…`
    : job.state === "done" ? `Done: ${job.opCount ?? 0} change${job.opCount === 1 ? "" : "s"}${job.firstOpMs != null ? ` · first in ${Math.round(job.firstOpMs)} ms` : ""}`
    : job.state === "aborted" ? `Stopped (${job.detail ?? "superseded"})`
    : `Couldn't build that: ${job.detail ?? "error"}`;

  return (
    <main style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>LiveCanvas</strong>
        <button type="button" onClick={listening ? stop : start} data-testid="mic" disabled={!canCreate && !listening} title={canCreate ? undefined : "Speaking to create is turned off"} style={{ ...pill(listening ? "#dc2626" : "#2563eb"), opacity: canCreate || listening ? 1 : 0.4 }}>
          {status === "connecting" ? "Connecting…" : listening ? "Stop listening" : "Start talking"}
        </button>
        <form onSubmit={submit} style={{ display: "flex", gap: 8, flex: "1 1 320px", minWidth: 0 }}>
          <label htmlFor="prompt" style={{ position: "absolute", left: -9999 }}>Describe a change</label>
          <input id="prompt" data-testid="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Or type it: add a login form"
            style={{ flex: 1, minWidth: 0, font: "inherit", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit" }} />
          <button type="submit" disabled={!connected || !prompt.trim() || !canCreate} style={{ ...pill("#0f172a"), opacity: connected && prompt.trim() && canCreate ? 1 : 0.5 }}>Build</button>
        </form>
        <div role="tablist" aria-label="Diagram kind" style={{ display: "flex", padding: 3, gap: 2, borderRadius: 999, border: "1px solid var(--lc-chrome-border)" }}>
          {KINDS.filter((k) => k.kind === kind || flags[kindFeature(k.kind)]).map((k) => (
            <button key={k.kind} type="button" role="tab" aria-selected={kind === k.kind} data-testid={`kind-${k.kind}`}
              onClick={() => kind !== k.kind && gateway.send({ type: "new_doc", kind: k.kind })}
              style={{ font: "inherit", fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                background: kind === k.kind ? "#0f172a" : "transparent", color: kind === k.kind ? "#fff" : "inherit" }}>{k.label}</button>
          ))}
        </div>
        <SharePopover />
        <button type="button" data-testid="undo" onClick={() => gateway.send({ type: "undo" })} disabled={!canUndo} title="Undo (⌘Z)" style={{ ...pill("transparent", "inherit"), opacity: canUndo ? 1 : 0.4 }}>Undo</button>
        <button type="button" data-testid="redo" onClick={() => gateway.send({ type: "redo" })} disabled={!canRedo} title="Redo (⇧⌘Z)" style={{ ...pill("transparent", "inherit"), opacity: canRedo ? 1 : 0.4 }}>Redo</button>
      </header>
      {/* One fixed-height line: status text changing length must never push the canvas (M4 reflow finding). */}
      <div style={{ padding: "0 24px", height: 28, lineHeight: "28px", fontSize: 13, opacity: 0.8, display: "flex", gap: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <span data-testid="status">{mode ? MODE_LABEL[mode] : "mic off"} · {status}{detail ? ` — ${detail}` : ""}</span>
        <span data-testid="conn">{connError ? `Gateway: ${connError}` : connected ? `Version ${version}` : "Connecting to gateway…"}</span>
        {notice ? <span data-testid="notice" style={{ color: "#b45309", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{notice}</span>
          : jobLabel && <span data-testid="job" style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{jobLabel}</span>}
      </div>
      {kind !== "screen" && <KeywordRail kind={kind} />}
      <div style={{ flex: 1 }}><Canvas doc={doc} /></div>
      <TranscriptStrip />
      {hud && <Hud />}
    </main>
  );
}
