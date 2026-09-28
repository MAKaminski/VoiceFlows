import { z } from "zod";

// Props reference tokens, never raw values (DESIGN_DSL.md). Raw hex lives only in token sets.
// Semantic tokens first, then named hues people say out loud ("make it pink") — M7, ADR 0019.
export const ColorToken = z.enum(["primary", "secondary", "surface", "muted", "danger", "text", "pink", "orange", "yellow", "green", "teal"]);
/** Fills light enough that text on them must be dark (contrast), e.g. a yellow button. */
export const LIGHT_FILLS: ReadonlySet<string> = new Set(["surface", "muted", "yellow"]);
export const SpaceToken = z.enum(["xs", "sm", "md", "lg", "xl"]);
export const RadiusToken = z.enum(["none", "sm", "md", "full"]);
export type ColorToken = z.infer<typeof ColorToken>;
export type SpaceToken = z.infer<typeof SpaceToken>;
export type RadiusToken = z.infer<typeof RadiusToken>;

export const TokenSet = z.object({
  color: z.record(ColorToken, z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  space: z.record(SpaceToken, z.number().int().nonnegative()),
  radius: z.record(RadiusToken, z.number().int().nonnegative()),
});
export type TokenSet = z.infer<typeof TokenSet>;

export const defaultTokens: TokenSet = {
  color: {
    primary: "#2563eb",
    secondary: "#7c3aed",
    surface: "#ffffff",
    muted: "#f1f5f9",
    danger: "#dc2626",
    text: "#0f172a",
    pink: "#db2777",
    orange: "#ea580c",
    yellow: "#facc15",
    green: "#16a34a",
    teal: "#0d9488",
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },
  radius: { none: 0, sm: 4, md: 10, full: 9999 },
};
