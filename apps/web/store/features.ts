"use client";
import { defaultFlags, type Flags, type ServerMsg, type VocabTerm } from "@livecanvas/dsl";
import { create } from "zustand";

/**
 * Feature flags, this document's words, and gateway notices (ADR 0012). The UI hides what a flag
 * turns off; the gateway enforces it regardless.
 */
interface FeatureState {
  flags: Flags;
  terms: VocabTerm[];
  /** This document's live share links, each pinned to a version (ADR 0013). */
  shares: Array<{ token: string; version: number }>;
  notice: string | null;
  applyServer(m: ServerMsg): void;
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

export const useFeatures = create<FeatureState>((set) => ({
  flags: defaultFlags(),
  terms: [],
  shares: [],
  notice: null,
  applyServer: (m) => {
    if (m.type === "welcome" && m.flags) set({ flags: m.flags });
    if (m.type === "flags") set({ flags: m.flags });
    if (m.type === "shares") set({ shares: m.links });
    if (m.type === "vocab") set((s) => ({ terms: m.terms, notice: !m.terms.some((t) => t.status === "proposed") && s.notice?.startsWith("Say “confirm”") ? null : s.notice }));
    if (m.type === "vocab_proposed") set({ notice: `Say “confirm” or click ✓ to add “${m.term.phrase}” → ${m.term.node.label}` });
    if (m.type === "error") {
      set({ notice: m.message });
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => set({ notice: null }), 5000);
    }
  },
}));
