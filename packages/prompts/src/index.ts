import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Loads /prompts/*.md and splits the cacheable static prefix from the per-call template.
const PREFIX_RE = /<!-- STATIC PREFIX[^>]*-->([\s\S]*?)<!-- END STATIC PREFIX -->([\s\S]*)/;

export interface Prompt {
  /** Static system text — sent with cache_control: ephemeral. */
  system: string;
  /** Render the dynamic tail with {{var}} substitution. */
  render(vars: Record<string, string>): string;
}

export type PromptName = "intent_system" | "patch_system" | "fused_system";

export function loadPrompt(name: PromptName, dir = process.env.PROMPTS_DIR ?? resolve(process.cwd(), "prompts")): Prompt {
  const raw = readFileSync(resolve(dir, `${name}.md`), "utf8");
  const m = PREFIX_RE.exec(raw);
  if (!m) throw new Error(`${name}.md is missing STATIC PREFIX markers`);
  const system = m[1]!.trim();
  const tail = m[2]!.trim();
  return {
    system,
    render: (vars) =>
      tail.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
        if (!(k in vars)) throw new Error(`${name}: missing template var ${k}`);
        return vars[k]!;
      }),
  };
}
