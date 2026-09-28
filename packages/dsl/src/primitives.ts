import { z } from "zod";
import { ColorToken, RadiusToken, SpaceToken } from "./tokens.js";

// The 12 screen primitives (D5) + 4 diagram primitives (ADR 0011). Adding one requires a DECISIONS.md change.
export const SCREEN_TYPES = [
  "Frame", "Stack", "Text", "Button", "Input", "Image",
  "Icon", "Card", "List", "Nav", "Table", "Chart",
] as const;
export const DIAGRAM_TYPES = ["Diagram", "Layer", "Node", "Edge"] as const;
/** The project root (ADR 0016): exactly four view roots — Screen, Architecture, ERD, Sequence. */
export const PRIMITIVE_TYPES = [...SCREEN_TYPES, ...DIAGRAM_TYPES, "Project"] as const;
export const PrimitiveType = z.enum(PRIMITIVE_TYPES);
export type PrimitiveType = z.infer<typeof PrimitiveType>;

const Direction = z.enum(["row", "column"]);
const Id = z.string().regex(/^n_[a-z0-9_]+$/);

/** The three diagram kinds (ADR 0011). Deliberately closed: no free-form diagramming. */
export const DiagramKind = z.enum(["architecture", "erd", "sequence", "constraints", "cva"]); // + constraints, cva (ADR 0021)
export type DiagramKind = z.infer<typeof DiagramKind>;
/** Architecture lanes = the four layers (Frontend, APIs, Database, Infrastructure). */
export const Tier = z.enum(["frontend", "api", "data", "infra", "other"]); // "other": a named extra lane (ADR 0016)
export type Tier = z.infer<typeof Tier>;
export const NodeKind = z.enum(["user", "client", "service", "db", "cache", "queue", "storage", "external", "cdn", "auth", "worker", "entity", "feature"]);
export type NodeKind = z.infer<typeof NodeKind>;
/** ERD column: `name:type` with optional `:pk` / `:fk`. */
export const ColumnSpec = z.string().regex(/^[a-z_][a-z0-9_]*:[a-z0-9_()\[\]]+(:pk|:fk)?$/i);
const Align = z.enum(["start", "center", "end", "stretch"]);

export const propSchemas = {
  Frame: z.object({
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    direction: Direction.optional(),
    gap: SpaceToken.optional(),
    padding: SpaceToken.optional(),
    align: Align.optional(),
    fill: ColorToken.optional(),
  }),
  Stack: z.object({
    direction: Direction.optional(),
    gap: SpaceToken.optional(),
    align: Align.optional(),
    justify: z.enum(["start", "center", "end", "between"]).optional(),
  }),
  Text: z.object({
    content: z.string(),
    variant: z.enum(["display", "title", "body", "caption"]).optional(),
    color: ColorToken.optional(),
  }),
  Button: z.object({
    label: z.string(),
    variant: z.enum(["primary", "secondary", "ghost"]).optional(),
    size: z.enum(["sm", "md", "lg"]).optional(),
    color: ColorToken.optional(),
    radius: RadiusToken.optional(),
  }),
  Input: z.object({
    label: z.string().optional(),
    placeholder: z.string().optional(),
    kind: z.enum(["text", "email", "password"]).optional(),
  }),
  Image: z.object({
    alt: z.string(),
    aspect: z.string().regex(/^\d+:\d+$/).optional(),
    src: z.string().url().optional(),
    radius: RadiusToken.optional(),
  }),
  Icon: z.object({
    name: z.string(),
    size: z.enum(["sm", "md", "lg"]).optional(),
    color: ColorToken.optional(),
  }),
  Card: z.object({
    padding: SpaceToken.optional(),
    elevation: z.number().int().min(0).max(3).optional(),
    fill: ColorToken.optional(), // "an orange card" (M7)
  }),
  List: z.object({
    items: z.array(z.object({ title: z.string(), subtitle: z.string().optional() })),
  }),
  Nav: z.object({
    items: z.array(z.string()),
    position: z.enum(["top", "bottom"]).optional(),
  }),
  Table: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }),
  Chart: z.object({
    kind: z.enum(["bar", "line"]),
    series: z.array(z.number()),
  }),
  // ── Diagrams (ADR 0011): positions are never props — layout.ts computes them from tree order.
  Diagram: z.object({ kind: DiagramKind, title: z.string().optional() }),
  Project: z.object({ title: z.string().max(80).optional(), notes: z.string().max(600).optional() }),
  Layer: z.object({ tier: Tier, label: z.string().optional() }),
  Node: z.object({
    label: z.string().min(1),
    kind: NodeKind.optional(),
    tech: z.string().optional(),
    cols: z.array(ColumnSpec).optional(),
    owner: z.string().max(40).optional(), // the team that owns it ("full-stack team") — a badge, not a box
    // Constraints view (ADR 0021): peak demand and capacity in `unit`s per second, p50 latency in ms.
    demand: z.number().nonnegative().optional(),
    capacity: z.number().positive().optional(),
    latency: z.number().nonnegative().optional(),
    unit: z.string().max(24).optional(),
    // Cost-value view (ADR 0021): 1 = low, 5 = high.
    cost: z.number().int().min(1).max(5).optional(),
    value: z.number().int().min(1).max(5).optional(),
  }),
  Edge: z.object({
    from: Id,
    to: Id,
    label: z.string().optional(),
    style: z.enum(["sync", "async", "return"]).optional(),
    card: z.enum(["1:1", "1:n", "n:1", "n:n"]).optional(),
    rate: z.number().nonnegative().optional(), // constraints: requests (or unit) per second on this hop
  }),
} satisfies Record<PrimitiveType, z.ZodTypeAny>;

export const CONTAINER_TYPES: ReadonlySet<PrimitiveType> = new Set(["Frame", "Stack", "Card", "Diagram", "Layer", "Project"]);

/** Allowed parent types per child type — screens and diagrams never mix (plan-critic #3). */
export const PARENTS: Record<PrimitiveType, ReadonlySet<PrimitiveType>> = Object.fromEntries([
  ...SCREEN_TYPES.map((t) => [t, new Set<PrimitiveType>(t === "Frame" ? ["Frame", "Stack", "Card", "Project"] : ["Frame", "Stack", "Card"])]),
  ["Diagram", new Set<PrimitiveType>(["Project"])], // a view root
  ["Project", new Set<PrimitiveType>()], // root only
  ["Layer", new Set<PrimitiveType>(["Diagram"])],
  ["Node", new Set<PrimitiveType>(["Diagram", "Layer"])],
  ["Edge", new Set<PrimitiveType>(["Diagram"])],
]) as Record<PrimitiveType, ReadonlySet<PrimitiveType>>;

// The prop the compact format's quoted string maps to (ADR 0002).
export const PRIMARY_TEXT_PROP: Partial<Record<PrimitiveType, string>> = {
  Text: "content", Button: "label", Input: "label", Image: "alt", Icon: "name",
  Diagram: "title", Layer: "label", Node: "label", Edge: "label", Project: "title",
};

/** Props the compact format always carries as arrays, even with a single element. */
export const ARRAY_PROPS: ReadonlySet<string> = new Set(["cols", "series", "columns"]);
