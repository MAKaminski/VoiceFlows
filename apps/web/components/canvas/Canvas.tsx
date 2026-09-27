"use client";
import { defaultTokens, type DesignDoc } from "@livecanvas/dsl";
import { DiagramCanvas } from "../diagram/DiagramCanvas";
import { CanvasNode } from "./CanvasNode";
import { tokenVars } from "./tokens";

export function Canvas({ doc }: { doc: DesignDoc }) {
  const diagram = doc.root.type === "Diagram";
  return (
    <div style={{ ...tokenVars(defaultTokens), display: "flex", justifyContent: diagram ? "safe center" : "center", padding: diagram ? "56px 32px 32px" : 32, overflowX: "auto" }}>
      {diagram ? <DiagramCanvas doc={doc} /> : <CanvasNode node={doc.root} />}
    </div>
  );
}
