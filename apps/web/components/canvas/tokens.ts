import type { SpaceToken, TokenSet } from "@livecanvas/dsl";
import type { CSSProperties } from "react";

/** Token set → CSS custom properties on the canvas root; primitives read only these vars. */
export function tokenVars(t: TokenSet): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.color)) vars[`--lc-color-${k}`] = v;
  for (const [k, v] of Object.entries(t.space)) vars[`--lc-space-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(t.radius)) vars[`--lc-radius-${k}`] = `${v}px`;
  return vars as CSSProperties;
}

export const color = (c: unknown, fallback = "text") => `var(--lc-color-${typeof c === "string" ? c : fallback})`;
export const space = (s: unknown) => (s ? `var(--lc-space-${s as SpaceToken})` : undefined);
export const radius = (r: unknown, fallback = "md") => `var(--lc-radius-${typeof r === "string" ? r : fallback})`;
