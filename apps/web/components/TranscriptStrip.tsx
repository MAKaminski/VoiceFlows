"use client";
import { lexTokens, type WordMark } from "@livecanvas/dsl";
import { useFeatures } from "@/store/features";
import { useVoice } from "@/store/voice";
import type { CSSProperties } from "react";

/**
 * Finals in solid ink, the live partial in grey (ARCHITECTURE.md §1). With `transcript_highlight`
 * (ADR 0012), each word shows what it did — drawn instantly (blue), your own word (green), or sent
 * to the model (violet) — so people learn which words work. Marks come from the gateway; the strip
 * only maps them onto the words it already shows.
 */
const STYLE: Record<WordMark["as"], CSSProperties> = {
  // box-shadow instead of padding: highlighting never shifts a word sideways.
  drawn: { background: "#dbeafe", color: "#1e40af", borderRadius: 4, boxShadow: "0 0 0 3px #dbeafe" },
  yours: { background: "#dcfce7", color: "#166534", borderRadius: 4, boxShadow: "0 0 0 3px #dcfce7" },
  model: { textDecoration: "underline dotted #7c3aed", textDecorationThickness: 2, textUnderlineOffset: 4 },
};
const TIP: Record<WordMark["as"], (m: WordMark) => string> = {
  drawn: (m) => (m.label ? `Drew “${m.label}” instantly` : "Drawn instantly (sets the next element’s look)"),
  yours: (m) => `Your word → drew “${m.label ?? ""}”`,
  model: () => "Sent to the model — it adds connections, edits and placement",
};

/** Splits display text into words and tags each with the occurrence keys of its lexicon tokens. */
function words(text: string, marks: Record<string, WordMark> | undefined) {
  const seen = new Map<string, number>();
  return text.split(/(\s+)/).map((part) => {
    if (!part.trim()) return { part, mark: undefined };
    let mark: WordMark | undefined;
    for (const tok of lexTokens(part)) {
      const k = (seen.get(tok) ?? 0) + 1;
      seen.set(tok, k);
      mark ??= marks?.[`${tok}#${k}`];
    }
    return { part, mark };
  });
}

export function TranscriptStrip() {
  const utterances = useVoice((s) => s.utterances);
  const marks = useVoice((s) => s.marks);
  const highlight = useFeatures((s) => s.flags.transcript_highlight);
  const seqs = Object.keys(utterances).map(Number).sort((a, b) => a - b).slice(-4);
  return (
    <div aria-live="polite" data-testid="transcript" style={{ position: "sticky", bottom: 0, background: "var(--lc-chrome-bg)", minHeight: 56, padding: "14px 24px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "1px solid var(--lc-chrome-border)",
      fontSize: 18, lineHeight: 1.6, display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
      {seqs.length === 0 && <span style={{ opacity: 0.5 }}>Say a screen — “a login screen with email and password, big blue sign-in button, logo on top.”</span>}
      {seqs.map((q) => (
        <span key={q} data-final={utterances[q]!.isFinal} style={{ opacity: utterances[q]!.isFinal ? 1 : 0.55 }}>
          {highlight
            ? words(utterances[q]!.text, marks[q]).map((w, i) => w.mark
              ? <span key={i} data-mark={w.mark.as} title={TIP[w.mark.as](w.mark)} style={STYLE[w.mark.as]}>{w.part}</span>
              : w.part)
            : utterances[q]!.text}
        </span>
      ))}
    </div>
  );
}
