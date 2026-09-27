"use client";
import { applyOp, emptyProject, type DesignDoc, type DocKind, type PatchOp, type ServerMsg } from "@livecanvas/dsl";
import { create } from "zustand";

export interface JobState { jobId: string; state: "running" | "done" | "aborted" | "failed"; text?: string; firstOpMs?: number; opCount?: number; detail?: string; startedAt: number }

interface DocState {
  /** The whole project (ADR 0016); `view` is the one this tab speaks to. */
  doc: DesignDoc;
  view: DocKind;
  connected: boolean;
  version: number;
  canUndo: boolean;
  canRedo: boolean;
  job: JobState | null;
  setDoc(doc: DesignDoc): void;
  setConnected(c: boolean): void;
  /** Applies ops in order; an op that fails to apply is dropped (never shown), per DESIGN_DSL.md. */
  applyOps(ops: PatchOp[]): void;
  /** Replica of the gateway's doc (ADR 0009): snapshots, op batches, versions, job status. */
  applyServer(m: ServerMsg): void;
}

export const useDoc = create<DocState>((set, get) => ({
  doc: emptyProject(),
  view: "screen",
  connected: false,
  version: 0, canUndo: false, canRedo: false,
  job: null,
  setDoc: (doc) => set({ doc }),
  setConnected: (connected) => set({ connected }),
  applyOps: (ops) =>
    set((s) => {
      let doc = s.doc;
      for (const op of ops) {
        try { doc = applyOp(doc, op); } catch (e) { console.warn("dropped op", op, e); }
      }
      return { doc };
    }),
  applyServer: (m) => {
    switch (m.type) {
      case "doc": return set({ doc: m.doc, version: m.version, canUndo: m.canUndo, canRedo: m.canRedo });
      case "ops": return get().applyOps(m.ops);
      case "version": return set({ version: m.version, canUndo: m.canUndo, canRedo: m.canRedo });
      case "view": return set({ view: m.view });
      case "job": {
        if (m.kind === "notes") return; // background notes rewrite: not a build the user started
        const prev = get().job;
        const startedAt = m.state === "running" || prev?.jobId !== m.jobId ? performance.now() : prev.startedAt;
        return set({ job: { ...m, text: m.text ?? prev?.text, startedAt } });
      }
    }
  },
}));
