import { z } from "zod";

// Props reference tokens, never raw values (DESIGN_DSL.md). Raw hex lives only in token sets.
export const ColorToken = z.enum(["primary", "secondary", "surface", "muted", "danger", "text"]);
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
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },
  radius: { none: 0, sm: 4, md: 10, full: 9999 },
};
