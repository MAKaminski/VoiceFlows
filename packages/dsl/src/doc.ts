import { z } from "zod";
import { CONTAINER_TYPES, PrimitiveType, propSchemas } from "./primitives.js";

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

export const DesignDocSchema = z.object({
  id: z.string(),
  tokens: z.string(),
  root: DesignNodeSchema,
});
export type DesignDoc = z.infer<typeof DesignDocSchema>;

export function emptyDoc(id = "doc"): DesignDoc {
  return {
    id,
    tokens: "default",
    root: {
      id: "n_root",
      type: "Frame",
      props: { width: 390, height: 844, direction: "column", gap: "md", padding: "lg", fill: "surface" },
      children: [],
    },
  };
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
