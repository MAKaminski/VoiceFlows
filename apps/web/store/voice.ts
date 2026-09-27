"use client";
import type { SttGrant } from "@livecanvas/dsl";
import { create } from "zustand";
import type { Transcript } from "@/lib/voice/session";

type Status = "idle" | "connecting" | "listening" | "stopped" | "error";

interface VoiceState {
  status: Status;
  detail: string | null;
  mode: SttGrant["mode"] | null;
  /** utteranceSeq → latest text; finals are solid, the rest grey (ARCHITECTURE.md §1 front-end). */
  utterances: Record<number, { text: string; isFinal: boolean }>;
  /** Every transcript event with its audio-clock time — read by the E2E latency harness. */
  log: Transcript[];
  framesSent: number;
  /** Peak |sample| of recent audio, 0–1 — drives the mic meter; 0 means silence reached the worklet. */
  level: number;
  countFrame(level: number): void;
  setStatus(s: Status, detail?: string): void;
  setMode(m: SttGrant["mode"]): void;
  push(t: Transcript): void;
  reset(): void;
}

export const useVoice = create<VoiceState>((set) => ({
  status: "idle", detail: null, mode: null, utterances: {}, log: [], framesSent: 0, level: 0,
  countFrame: (level) => set((s) => ({ framesSent: s.framesSent + 1, level: Math.max(level, s.level * 0.8) })),
  setStatus: (status, detail) => set({ status, detail: detail ?? null }),
  setMode: (mode) => set({ mode }),
  push: (t) => set((s) => ({
    utterances: s.utterances[t.utteranceSeq]?.isFinal ? s.utterances : { ...s.utterances, [t.utteranceSeq]: { text: t.text, isFinal: t.isFinal } },
    log: [...s.log, t],
  })),
  reset: () => set({ utterances: {}, log: [], detail: null, framesSent: 0 }),
}));
