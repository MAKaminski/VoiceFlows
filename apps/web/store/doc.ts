"use client";
import { applyOp, type DesignDoc, type PatchOp } from "@livecanvas/dsl";
import { create } from "zustand";

interface DocState {
  doc: DesignDoc;
  setDoc(doc: DesignDoc): void;
  /** Applies ops in order; an invalid op is dropped (never shown), per DESIGN_DSL.md. */
  applyOps(ops: PatchOp[]): void;
}

export const useDoc = create<DocState>((set) => ({
  doc: { id: "empty", tokens: "default", root: { id: "n_root", type: "Frame", props: {}, children: [] } },
  setDoc: (doc) => set({ doc }),
  applyOps: (ops) =>
    set((s) => {
      let doc = s.doc;
      for (const op of ops) {
        try { doc = applyOp(doc, op); } catch (e) { console.warn("dropped op", op, e); }
      }
      return { doc };
    }),
}));
