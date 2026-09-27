import { z } from "zod";

// RFC 6902 — the internal edit contract (D4). Model output is compact lines (ADR 0002), expanded here.
const Pointer = z.string().regex(/^(\/[^/]*)*$/);
export const PatchOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), path: Pointer, value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: Pointer }),
  z.object({ op: z.literal("replace"), path: Pointer, value: z.unknown() }),
  z.object({ op: z.literal("move"), from: Pointer, path: Pointer }),
  z.object({ op: z.literal("copy"), from: Pointer, path: Pointer }),
  z.object({ op: z.literal("test"), path: Pointer, value: z.unknown() }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

const unescape = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");

function walk(doc: unknown, path: string): { parent: any; key: string } {
  const parts = path.split("/").slice(1).map(unescape);
  const key = parts.pop();
  if (key === undefined) throw new Error("cannot target document root");
  let parent: any = doc;
  for (const p of parts) {
    parent = Array.isArray(parent) ? parent[Number(p)] : parent?.[p];
    if (parent === undefined) throw new Error(`path not found: ${path}`);
  }
  return { parent, key };
}

function get(doc: unknown, path: string): unknown {
  const { parent, key } = walk(doc, path);
  return Array.isArray(parent) ? parent[Number(key)] : parent[key];
}

/** Shallow-copies every container from the root down to the parent of `path` (copy-on-write). */
function cow(root: any, path: string): { root: any; parent: any; key: string } {
  const parts = path.split("/").slice(1).map(unescape);
  const key = parts.pop();
  if (key === undefined) throw new Error("cannot target document root");
  const copy = (v: any) => (Array.isArray(v) ? v.slice() : { ...v });
  const next = copy(root);
  let cur = next;
  for (const p of parts) {
    const child = Array.isArray(cur) ? cur[Number(p)] : cur[p];
    if (child === null || typeof child !== "object") throw new Error(`path not found: ${path}`);
    const c = copy(child);
    if (Array.isArray(cur)) cur[Number(p)] = c; else cur[p] = c;
    cur = c;
  }
  return { root: next, parent: cur, key };
}

/**
 * Applies one op immutably with structural sharing: only containers on the op's path are copied,
 * so untouched subtrees keep their identity and per-node React.memo skips them (ARCHITECTURE F1).
 * The input doc is never mutated. Throws on an invalid path.
 */
export function applyOp<T>(doc: T, op: PatchOp): T {
  const put = (d: any, path: string, value: unknown) => {
    const { root, parent, key } = cow(d, path);
    if (Array.isArray(parent)) {
      const idx = key === "-" ? parent.length : Number(key);
      if (!(Number.isInteger(idx) && idx >= 0 && idx <= parent.length)) throw new Error(`bad index: ${path}`);
      parent.splice(idx, 0, value);
    } else parent[key] = value;
    return root;
  };
  const del = (d: any, path: string) => {
    const { root, parent, key } = cow(d, path);
    if (Array.isArray(parent)) {
      const idx = Number(key);
      if (!(Number.isInteger(idx) && idx >= 0 && idx < parent.length)) throw new Error(`path not found: ${path}`);
      parent.splice(idx, 1);
    } else if (key in parent) delete parent[key];
    else throw new Error(`path not found: ${path}`);
    return root;
  };
  switch (op.op) {
    case "add": return put(doc, op.path, structuredClone(op.value));
    case "remove": return del(doc, op.path);
    case "replace": {
      get(doc, op.path); // throws if the target is missing
      const { root, parent, key } = cow(doc, op.path);
      if (Array.isArray(parent)) parent[Number(key)] = structuredClone(op.value);
      else parent[key] = structuredClone(op.value);
      return root;
    }
    case "move": { const v = get(doc, op.from); return put(del(doc, op.from), op.path, v); }
    case "copy": return put(doc, op.path, structuredClone(get(doc, op.from)));
    case "test":
      if (JSON.stringify(get(doc, op.path)) !== JSON.stringify(op.value)) throw new Error(`test failed: ${op.path}`);
      return doc;
  }
}

/** Inverse op for rollback (INTENT_ENGINE.md speculative generation). Computed against the pre-op doc. */
export function invertOp(before: unknown, op: PatchOp): PatchOp {
  switch (op.op) {
    case "add": return { op: "remove", path: op.path.endsWith("/-") ? resolveAppend(before, op.path) : op.path };
    case "remove": return { op: "add", path: op.path, value: get(before, op.path) };
    case "replace": return { op: "replace", path: op.path, value: get(before, op.path) };
    case "move": return { op: "move", from: op.path, path: op.from };
    case "copy": return { op: "remove", path: op.path };
    case "test": return op;
  }
}

function resolveAppend(before: unknown, path: string): string {
  const arr = get(before, path.slice(0, -2)) as unknown[];
  return `${path.slice(0, -2)}/${arr.length}`;
}

/** Rewrites an op's pointer(s) — used to move ops between a view doc and its project (ADR 0016). */
export function mapOpPaths(op: PatchOp, f: (path: string) => string): PatchOp {
  return "from" in op ? { ...op, path: f(op.path), from: f(op.from) } : { ...op, path: f(op.path) };
}
