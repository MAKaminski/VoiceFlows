import { describe, expect, it } from "vitest";
import { applyOp, DesignDocSchema, emptyProject, expandCompact, findNode, layoutDiagram, ServerMsg, toProject, utilization, viewDoc, VIEWS, type CompactContext, type DesignDoc } from "../src/index.js";

/** ADR 0021: six views; projects saved with four are padded on every parse. */
const fourView = (): DesignDoc => { const p = emptyProject(); return { ...p, root: { ...p.root, children: p.root.children!.slice(0, 4) } }; };

describe("six views (ADR 0021)", () => {
  it("a 4-view project from M8 parses — as a doc message too — and comes out with 6 views", () => {
    expect(VIEWS.map((v) => v.kind)).toEqual(["screen", "architecture", "erd", "sequence", "constraints", "cva"]);
    const parsed = DesignDocSchema.parse(fourView());
    expect(parsed.root.children!.map((c) => c.id)).toEqual(VIEWS.map((v) => v.id));
    const msg = ServerMsg.parse({ type: "doc", doc: fourView(), version: 3, canUndo: true, canRedo: false });
    expect((msg as { doc: DesignDoc }).doc.root.children).toHaveLength(6);
    expect(toProject(fourView()).root.children).toHaveLength(6);
  });

  it("constraints: components in a row, rates on hops, a bottleneck at ≥ 80% of capacity", () => {
    let d = viewDoc(emptyProject(), "constraints");
    const ctx: CompactContext = { resolve: (r) => (r === "root" ? "/root" : findNode(d.root, `n_${r}`)?.path ?? null), assignId: (a) => `n_${a}`, idOf: (r) => `n_${r}` };
    for (const line of ['+Node api >root k=service dm=500 cp=800 "API"', '+Node pg >root k=db dm=500 cp=200 "Postgres"', "+Edge e1 >root from=api to=pg rt=500 \"writes\""])
      for (const op of expandCompact(line, ctx)) d = applyOp(d, op);
    const l = layoutDiagram(d)!;
    expect(l.kind).toBe("constraints");
    expect(l.nodes.n_pg!.x).toBeGreaterThan(l.nodes.n_api!.x);
    expect(l.edges[0]!.label).toBe("writes · 500/s");
    expect(utilization(findNode(d.root, "n_pg")!.node)).toBe(2.5);
    expect(utilization(findNode(d.root, "n_api")!.node)).toBe(0.625);
  });

  it("cost-value: scored items land in their quadrant; unscored ones wait in the strip", () => {
    const root = { ...viewDoc(emptyProject(), "cva").root, children: [
      { id: "n_a", type: "Node" as const, props: { label: "Sign in", kind: "feature", cost: 1, value: 5 } },
      { id: "n_b", type: "Node" as const, props: { label: "AI routing", kind: "feature", cost: 5, value: 5 } },
      { id: "n_c", type: "Node" as const, props: { label: "Dark mode", kind: "feature" } },
    ] };
    const l = layoutDiagram({ id: "d", tokens: "default", root })!;
    const q = (id: string) => l.lanes.find((x) => { const r = l.nodes[id]!; return r.x >= x.x && r.x < x.x + x.w && r.y >= x.y && r.y < x.y + x.h; })?.tier;
    expect(q("n_a")).toBe("quick");
    expect(q("n_b")).toBe("big");
    expect(q("n_c")).toBeUndefined(); // below the matrix
  });
});
