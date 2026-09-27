"use client";
import { create } from "zustand";

/** Client-measured latency (M4 HUD). All times are on the audio clock: ms since capture started. */
interface Metrics {
  ttfv0: number[]; // lexicon batches: render − trigger word end
  ttfv1: number[]; // first model op of each job: render − last word of its input
  settle: number[]; // version render after a final transcript − that transcript's last word end
  reflowMaxPerElement: number[]; // per utterance
  modelCalls: number;
  dollars: number;
  speakingMs: number;
  seenJobs: Set<string>;
  pendingFinalEndMs: number | null;
  audioClock: (() => number | null) | null;
  add(key: "ttfv0" | "ttfv1" | "settle" | "reflowMaxPerElement", v: number): void;
  reset(): void;
}

export const useMetrics = create<Metrics>((set) => ({
  ttfv0: [], ttfv1: [], settle: [], reflowMaxPerElement: [], modelCalls: 0, dollars: 0, speakingMs: 0,
  seenJobs: new Set(), pendingFinalEndMs: null, audioClock: null,
  add: (key, v) => set((s) => ({ [key]: [...s[key], v].slice(-200) }) as Partial<Metrics>),
  reset: () => set({ ttfv0: [], ttfv1: [], settle: [], reflowMaxPerElement: [], modelCalls: 0, dollars: 0, speakingMs: 0, seenJobs: new Set(), pendingFinalEndMs: null }),
}));

export const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!);
};

// Haiku 4.5 list price, 2026-09-26 (docs/COST_MODEL.md).
export const dollarsFor = (inTok: number, outTok: number) => (inTok * 1 + outTok * 5) / 1e6;
