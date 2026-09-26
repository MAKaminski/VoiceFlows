"use client";
import { defaultTokens, type DesignDoc } from "@livecanvas/dsl";
import { CanvasNode } from "./CanvasNode";
import { tokenVars } from "./tokens";

export function Canvas({ doc }: { doc: DesignDoc }) {
  return (
    <div style={{ ...tokenVars(defaultTokens), display: "flex", justifyContent: "center", padding: 32 }}>
      <CanvasNode node={doc.root} />
    </div>
  );
}
