import { z } from "zod";
import { ColorToken, RadiusToken, SpaceToken } from "./tokens.js";

// The 12 renderable primitives (D5). Adding one requires a DECISIONS.md change.
export const PRIMITIVE_TYPES = [
  "Frame", "Stack", "Text", "Button", "Input", "Image",
  "Icon", "Card", "List", "Nav", "Table", "Chart",
] as const;
export const PrimitiveType = z.enum(PRIMITIVE_TYPES);
export type PrimitiveType = z.infer<typeof PrimitiveType>;

const Direction = z.enum(["row", "column"]);
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
} satisfies Record<PrimitiveType, z.ZodTypeAny>;

export const CONTAINER_TYPES: ReadonlySet<PrimitiveType> = new Set(["Frame", "Stack", "Card"]);

// The prop the compact format's quoted string maps to (ADR 0002).
export const PRIMARY_TEXT_PROP: Partial<Record<PrimitiveType, string>> = {
  Text: "content", Button: "label", Input: "label", Image: "alt", Icon: "name",
};
