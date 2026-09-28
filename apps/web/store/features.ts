"use client";
import { defaultFlags, type Flags, type ServerMsg, type Suggestion, type VersionSummary, type VocabTerm } from "@livecanvas/dsl";
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
  /** Another tab took this document over (ADR 0014): this tab is idle until the user takes it back. */
  takenOver: boolean;
  /** Version timeline (ADR 0015): summaries of every version and which one is on screen. */
  timeline: { current: number; path: number[]; items: VersionSummary[] };
  /** Pending implied suggestions, all views (ADR 0020) — not in the doc until approved. */
  suggestions: Suggestion[];
  /** Library state of this project (ADR 0020). */
  project: { savedAt: string | null; title?: string };
  /** Opened from the library while another tab edits it: offered read-only (ADR 0020). */
  inUse: string | null;
  /** The project this tab has open (from `welcome`). */
  documentId: string | null;
  applyServer(m: ServerMsg): void;
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

export const useFeatures = create<FeatureState>((set) => ({
  flags: defaultFlags(),
  terms: [],
  shares: [],
  notice: null,
  takenOver: false,
  timeline: { current: 0, path: [], items: [] },
  suggestions: [],
  project: { savedAt: null },
  inUse: null,
  documentId: null,
  applyServer: (m) => {
    if (m.type === "welcome" && m.documentId) set({ documentId: m.documentId });
    if (m.type === "suggestions") set({ suggestions: m.items });
    if (m.type === "project") set({ project: { savedAt: m.savedAt, ...(m.title ? { title: m.title } : {}) } });
    if (m.type === "in_use") set({ inUse: m.documentId });
    if (m.type === "taken_over") set({ takenOver: true });
    if (m.type === "versions") set({ timeline: { current: m.current, path: m.path, items: m.items } });
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
