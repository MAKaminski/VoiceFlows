"use client";
import { defaultTokens, type DesignDoc } from "@livecanvas/dsl";
import { DiagramCanvas } from "../diagram/DiagramCanvas";
import { CanvasNode } from "./CanvasNode";
import { FitBox } from "./FitBox";
import { tokenVars } from "./tokens";

/** One view of the project. `fit` scales it into its box (the all-views grid, ADR 0020). */
export function Canvas({ doc, fit }: { doc: DesignDoc; fit?: boolean }) {
  const diagram = doc.root.type === "Diagram";
  const body = (
    <div style={{ ...tokenVars(defaultTokens), display: "flex", justifyContent: diagram ? "safe center" : "center", padding: diagram ? "56px 32px 32px" : 32, overflowX: fit ? "visible" : "auto" }}>
      {diagram ? <DiagramCanvas doc={doc} /> : <CanvasNode node={doc.root} viewRoot />}
    </div>
  );
  return fit ? <FitBox>{body}</FitBox> : body;
}
