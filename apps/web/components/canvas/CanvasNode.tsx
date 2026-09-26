"use client";
import type { DesignNode } from "@livecanvas/dsl";
import { memo } from "react";
import { renderers } from "./primitives";

/**
 * Per-node memo keyed by node id. applyOp structurally clones, so unchanged subtrees keep
 * referential equality only if the patch path didn't touch them — M3 switches to structural
 * sharing so a single op re-renders only its ancestors.
 */
export const CanvasNode = memo(function CanvasNode({ node }: { node: DesignNode }) {
  const children = node.children?.map((c) => <CanvasNode key={c.id} node={c} />);
  return (
    <div data-node-id={node.id} data-type={node.type} className={node.provisional ? "lc-provisional" : undefined} style={{ display: "contents" }}>
      {renderers[node.type](node.props, children)}
    </div>
  );
});
