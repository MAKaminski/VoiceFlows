import type { PatchOp } from "./ops.js";
import type { DesignNode } from "./doc.js";
import { PRIMARY_TEXT_PROP, PrimitiveType } from "./primitives.js";

// ADR 0002 — compact model wire format, expanded to RFC 6902 before validation.
//   +<Type> <alias> ><parentRef> [k=v ...] ["text"] [@index]   add (appended, or inserted at @index)
//   ~<ref> [k=v ...] ["text"]                         replace props
//   -<ref>                                            remove
//   ^<ref> ><parentRef> [@index]                      move

export const SHORT_KEYS: Record<string, string> = {
  v: "variant", s: "size", c: "color", g: "gap", p: "padding", d: "direction",
  a: "align", j: "justify", r: "radius", k: "kind", f: "fill", w: "width", h: "height",
};

export interface CompactContext {
  /** JSON Pointer of the node for a ref (`root`, `n_…` id, or alias); null if unknown. */
  resolve(ref: string): string | null;
  /** Assigns the stable `n_…` id for a new alias (ids are never chosen by the model). */
  assignId(alias: string): string;
}

export class CompactParseError extends Error {}

const TOKEN_RE = /([A-Za-z]\w*)="((?:[^"\\]|\\.)*)"|"((?:[^"\\]|\\.)*)"|(\S+)/g;

function tokenize(line: string) {
  const out: Array<{ key?: string; value: string; quoted: boolean }> = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) out.push({ key: m[1], value: unq(m[2]!), quoted: true });
    else if (m[3] !== undefined) out.push({ value: unq(m[3]), quoted: true });
    else out.push({ value: m[4]!, quoted: false });
  }
  return out;
}
const unq = (s: string) => s.replace(/\\(.)/g, "$1");

function scalar(v: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  if (v.includes(",")) return v.split(",").map((x) => scalar(x));
  return v;
}

function parseProps(tokens: ReturnType<typeof tokenize>, type: PrimitiveType | null) {
  const props: Record<string, unknown> = {};
  for (const t of tokens) {
    if (t.key) props[SHORT_KEYS[t.key] ?? t.key] = t.value;
    else if (t.quoted) {
      const key = type ? PRIMARY_TEXT_PROP[type] : undefined;
      if (!key) throw new CompactParseError(`no primary text prop for ${type ?? "unknown type"}`);
      props[key] = t.value;
    } else {
      const eq = t.value.indexOf("=");
      if (eq <= 0) throw new CompactParseError(`bad prop token: ${t.value}`);
      const k = t.value.slice(0, eq);
      props[SHORT_KEYS[k] ?? k] = scalar(t.value.slice(eq + 1));
    }
  }
  return props;
}

function need(ctx: CompactContext, ref: string): string {
  const p = ctx.resolve(ref);
  if (!p) throw new CompactParseError(`unknown ref: ${ref}`);
  return p;
}

/**
 * Expands one compact line into RFC 6902 ops. `typeOf` supplies an existing node's type so a
 * bare quoted string in a `~` line maps to the right prop.
 */
export function expandCompact(
  line: string,
  ctx: CompactContext,
  typeOf: (ref: string) => PrimitiveType | null = () => null,
): PatchOp[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const sigil = trimmed[0];
  const tokens = tokenize(trimmed.slice(1));
  const head = tokens.shift();
  if (!head) throw new CompactParseError(`empty op: ${line}`);

  switch (sigil) {
    case "+": {
      const type = PrimitiveType.safeParse(head.value);
      if (!type.success) throw new CompactParseError(`unknown primitive: ${head.value}`);
      const alias = tokens.shift()?.value;
      const parent = tokens.shift()?.value;
      if (!alias || !parent?.startsWith(">")) throw new CompactParseError(`add needs <alias> ><parent>: ${line}`);
      const parentPath = need(ctx, parent.slice(1));
      const at = tokens.findIndex((t) => !t.quoted && /^@\d+$/.test(t.value));
      const index = at >= 0 ? tokens.splice(at, 1)[0]!.value.slice(1) : "-";
      const value = { id: ctx.assignId(alias), type: type.data, props: parseProps(tokens, type.data) };
      return [{ op: "add", path: `${parentPath}/children/${index}`, value }];
    }
    case "~": {
      const path = need(ctx, head.value);
      const props = parseProps(tokens, typeOf(head.value));
      return Object.entries(props).map(([k, v]) => ({ op: "replace", path: `${path}/props/${k}`, value: v }));
    }
    case "-":
      return [{ op: "remove", path: need(ctx, head.value) }];
    case "^": {
      const from = need(ctx, head.value);
      const parent = tokens.shift()?.value;
      if (!parent?.startsWith(">")) throw new CompactParseError(`move needs ><parent>: ${line}`);
      const at = tokens.shift()?.value;
      const idx = at?.startsWith("@") ? at.slice(1) : "-";
      return [{ op: "move", from, path: `${need(ctx, parent.slice(1))}/children/${idx}` }];
    }
    default:
      throw new CompactParseError(`unknown sigil '${sigil}': ${line}`);
  }
}

const REVERSE_SHORT: Record<string, string> = Object.fromEntries(Object.entries(SHORT_KEYS).map(([k, v]) => [v, k]));

function fmtValue(v: unknown): string {
  if (Array.isArray(v) && v.every((x) => typeof x === "number" || (typeof x === "string" && /^[\w.:-]+$/.test(x)))) return v.join(",");
  if (typeof v === "string") return /^[\w.:#-]+$/.test(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(JSON.stringify(v)); // complex values (List items, Table rows) as a quoted JSON string
}

/**
 * Serializes a doc as compact `+` lines in tree order (model context, ADR 0002) — about 3× fewer
 * tokens than the JSON doc. Node ids are used as aliases so the model can reference them directly.
 */
export function serializeCompact(root: DesignNode, parent = "", out: string[] = []): string {
  if (parent) {
    const text = PRIMARY_TEXT_PROP[root.type];
    const props = Object.entries(root.props)
      .filter(([k]) => k !== text)
      .map(([k, v]) => `${REVERSE_SHORT[k] ?? k}=${fmtValue(v)}`);
    const quoted = text && typeof root.props[text] === "string" ? ` ${JSON.stringify(root.props[text])}` : "";
    out.push(`+${root.type} ${root.id} >${parent}${props.length ? " " + props.join(" ") : ""}${quoted}${root.provisional ? " ?provisional" : ""}`);
  }
  for (const c of root.children ?? []) serializeCompact(c, parent ? root.id : "root", out);
  return out.join("\n");
}
