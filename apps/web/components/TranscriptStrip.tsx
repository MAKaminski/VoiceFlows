"use client";
import { useVoice } from "@/store/voice";

/** Finals in solid ink, the live partial in grey (ARCHITECTURE.md §1). */
export function TranscriptStrip() {
  const utterances = useVoice((s) => s.utterances);
  const seqs = Object.keys(utterances).map(Number).sort((a, b) => a - b).slice(-4);
  return (
    <div aria-live="polite" data-testid="transcript" style={{ position: "sticky", bottom: 0, background: "var(--lc-chrome-bg)", minHeight: 56, padding: "14px 24px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "1px solid var(--lc-chrome-border)",
      fontSize: 18, lineHeight: 1.5, display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
      {seqs.length === 0 && <span style={{ opacity: 0.5 }}>Say a screen — “a login screen with email and password, big blue sign-in button, logo on top.”</span>}
      {seqs.map((q) => (
        <span key={q} data-final={utterances[q]!.isFinal} style={{ opacity: utterances[q]!.isFinal ? 1 : 0.55 }}>{utterances[q]!.text}</span>
      ))}
    </div>
  );
}
