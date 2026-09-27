import { z } from "zod";
import { CONTAINER_TYPES, DiagramKind, PARENTS, PrimitiveType, propSchemas, type Tier } from "./primitives.js";

export interface DesignNode {
  id: string;
  type: PrimitiveType;
  props: Record<string, unknown>;
  provisional?: boolean; // set by the lexicon tier (D15); cleared when the model touches the node
  children?: DesignNode[];
}

export const NodeId = z.string().regex(/^n_[a-z0-9_]+$/);

export const DesignNodeSchema: z.ZodType<DesignNode> = z.lazy(() =>
  z
    .object({
      id: NodeId,
      type: PrimitiveType,
      props: z.record(z.string(), z.unknown()),
      provisional: z.boolean().optional(),
      children: z.array(DesignNodeSchema).optional(),
    })
    .superRefine((node, ctx) => {
      const res = propSchemas[node.type].safeParse(node.props);
      if (!res.success) {
        ctx.addIssue({ code: "custom", message: `${node.type} props: ${res.error.message}` });
      }
      if (node.children && !CONTAINER_TYPES.has(node.type)) {
        ctx.addIssue({ code: "custom", message: `${node.type} cannot have children` });
      }
    }),
);

/**
 * Whole-doc rules a single node can't check (ADR 0011): the root is a Frame (screen) or a Diagram;
 * every child sits under an allowed parent type, so screen and diagram primitives never mix; every
 * Edge points at two existing Nodes (the gateway prunes edges whose endpoint was removed).
 */
function checkTree(root: DesignNode): string | null {
  if (root.type === "Project") {
    // ADR 0016: exactly the four view roots, in order, each valid on its own; ids unique project-wide.
    const kids = root.children ?? [];
    if (kids.length !== VIEWS.length) return `Project needs ${VIEWS.length} views, got ${kids.length}`;
    for (const [i, v] of VIEWS.entries()) {
      const c = kids[i]!;
      if (c.id !== v.id || (v.kind === "screen" ? c.type !== "Frame" : c.type !== "Diagram" || c.props.kind !== v.kind)) return `view ${i} must be ${v.id}`;
      const err = checkTree(c);
      if (err) return `${v.kind}: ${err}`;
    }
    const seen = new Set<string>();
    const dup = (n: DesignNode): string | null => {
      if (seen.has(n.id)) return n.id;
      seen.add(n.id);
      for (const c of n.children ?? []) { const d = dup(c); if (d) return d; }
      return null;
    };
    const d = dup(root);
    return d ? `duplicate id ${d}` : null;
  }
  if (root.type !== "Frame" && root.type !== "Diagram") return `root must be Frame or Diagram, got ${root.type}`;
  const nodeIds = new Set<string>();
  const edges: DesignNode[] = [];
  const walk = (n: DesignNode): string | null => {
    for (const c of n.children ?? []) {
      if (!PARENTS[c.type].has(n.type)) return `${c.type} cannot be a child of ${n.type}`;
      if (c.type === "Node") nodeIds.add(c.id);
      if (c.type === "Edge") edges.push(c);
      const err = walk(c);
      if (err) return err;
    }
    return null;
  };
  const err = walk(root);
  if (err) return err;
  if (root.type === "Diagram") {
    const kind = root.props.kind;
    for (const c of root.children ?? []) {
      if (c.type === "Layer" && kind !== "architecture") return `Layer only in architecture diagrams`;
      if (c.type === "Node" && kind === "architecture") return `architecture Nodes belong in a Layer`;
    }
  }
  for (const e of edges) {
    if (!nodeIds.has(String(e.props.from)) || !nodeIds.has(String(e.props.to))) return `Edge ${e.id} points at a missing node`;
  }
  return null;
}

export const DesignDocSchema = z
  .object({
    id: z.string(),
    tokens: z.string(),
    root: DesignNodeSchema,
  })
  .superRefine((doc, ctx) => {
    const err = checkTree(doc.root);
    if (err) ctx.addIssue({ code: "custom", message: err });
  });
export type DesignDoc = z.infer<typeof DesignDocSchema>;

/** What a doc is: a phone screen or one of the three diagram kinds. */
export const DocKind = z.enum(["screen", ...DiagramKind.options]);
export type DocKind = z.infer<typeof DocKind>;

/** Kind of a view doc (a Frame or Diagram root). A project doc has four — see `VIEWS`. */
export const docKind = (doc: DesignDoc): DocKind => (doc.root.type === "Diagram" ? (doc.root.props.kind as DocKind) : "screen");

// ── Projects (ADR 0016): one document, four views ─────────────────────────────────────────────────
export const VIEWS: ReadonlyArray<{ kind: DocKind; id: string; label: string }> = [
  { kind: "screen", id: "n_view_screen", label: "Screen" },
  { kind: "architecture", id: "n_view_architecture", label: "Architecture" },
  { kind: "erd", id: "n_view_erd", label: "ERD" },
  { kind: "sequence", id: "n_view_sequence", label: "Sequence" },
];
export const viewIndex = (kind: DocKind) => VIEWS.findIndex((v) => v.kind === kind);

/** An empty view root with its project id. */
export const emptyView = (kind: DocKind): DesignNode => ({ ...emptyRoot(kind), id: VIEWS[viewIndex(kind)]!.id });

export function emptyProject(id = "doc"): DesignDoc {
  return { id, tokens: "default", root: { id: "n_root", type: "Project", props: {}, children: VIEWS.map((v) => emptyView(v.kind)) } };
}

/** Upgrades a single-view doc (pre-M6) into a project; that view keeps its content. Idempotent. */
export function toProject(doc: DesignDoc): DesignDoc {
  if (doc.root.type === "Project") return doc;
  const kind = docKind(doc);
  return { ...doc, root: { id: "n_root", type: "Project", props: {}, children: VIEWS.map((v) => (v.kind === kind ? { ...doc.root, id: v.id } : emptyView(v.kind))) } };
}

/** The view doc the engine works on: same doc, root = that view's root. */
export function viewDoc(project: DesignDoc, kind: DocKind): DesignDoc {
  return { ...project, root: project.root.children![viewIndex(kind)]! };
}

/** Writes a view root back into the project (structural sharing: only the root and its children array copy). */
export function withView(project: DesignDoc, kind: DocKind, root: DesignNode): DesignDoc {
  const children = project.root.children!.slice();
  children[viewIndex(kind)] = root;
  return { ...project, root: { ...project.root, children } };
}

/** `/root…` in a view doc ↔ `/root/children/<i>…` in the project. */
export const toProjectPath = (path: string, kind: DocKind) => `/root/children/${viewIndex(kind)}${path.slice("/root".length)}`;
export function fromProjectPath(path: string, kind: DocKind): string | null {
  const prefix = `/root/children/${viewIndex(kind)}`;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return null;
  return `/root${path.slice(prefix.length)}`;
}

/** Element count of a view (what the view tabs show). */
export function viewCount(root: DesignNode): number {
  let n = 0;
  const walk = (x: DesignNode) => { for (const c of x.children ?? []) { if (c.type !== "Layer") n++; walk(c); } };
  walk(root);
  return n;
}

/** Architecture lanes, top to bottom — fixed ids so the model and lexicon address them directly. */
export const LANES: ReadonlyArray<{ id: string; tier: Tier; label: string }> = [
  { id: "n_frontend", tier: "frontend", label: "Frontend" },
  { id: "n_api", tier: "api", label: "APIs" },
  { id: "n_data", tier: "data", label: "Database" },
  { id: "n_infra", tier: "infra", label: "Infrastructure" },
];

export function emptyRoot(kind: DocKind = "screen"): DesignNode {
  if (kind === "screen") {
    return {
      id: "n_root", type: "Frame",
      props: { width: 390, height: 844, direction: "column", gap: "md", padding: "lg", fill: "surface" },
      children: [],
    };
  }
  return {
    id: "n_root", type: "Diagram", props: { kind },
    children: kind === "architecture"
      ? LANES.map((l) => ({ id: l.id, type: "Layer" as const, props: { tier: l.tier, label: l.label }, children: [] }))
      : [],
  };
}

export function emptyDoc(opts: { id?: string; kind?: DocKind } = {}): DesignDoc {
  return { id: opts.id ?? "doc", tokens: "default", root: emptyRoot(opts.kind) };
}

/** True when the doc holds nothing the user made (seeded lanes don't count) — kind may switch freely. */
export function isBlank(doc: DesignDoc): boolean {
  const kids = doc.root.children ?? [];
  return kids.every((c) => c.type === "Layer" && !(c.children?.length));
}

/** Depth-first node lookup by id; returns the JSON Pointer to the node. */
export function findNode(root: DesignNode, id: string, path = "/root"): { node: DesignNode; path: string } | null {
  if (root.id === id) return { node: root, path };
  for (const [i, child] of (root.children ?? []).entries()) {
    const hit = findNode(child, id, `${path}/children/${i}`);
    if (hit) return hit;
  }
  return null;
}
