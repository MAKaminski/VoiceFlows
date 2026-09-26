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

/** Applies one op immutably (structural clone) and returns the new doc. Throws on invalid path. */
export function applyOp<T>(doc: T, op: PatchOp): T {
  const next = structuredClone(doc);
  const put = (path: string, value: unknown) => {
    const { parent, key } = walk(next, path);
    if (Array.isArray(parent)) {
      const idx = key === "-" ? parent.length : Number(key);
      if (!(idx >= 0 && idx <= parent.length)) throw new Error(`bad index: ${path}`);
      parent.splice(idx, 0, value);
    } else parent[key] = value;
  };
  const del = (path: string) => {
    const { parent, key } = walk(next, path);
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else if (key in parent) delete parent[key];
    else throw new Error(`path not found: ${path}`);
  };
  switch (op.op) {
    case "add": put(op.path, structuredClone(op.value)); break;
    case "remove": del(op.path); break;
    case "replace": {
      const { parent, key } = walk(next, op.path);
      if (Array.isArray(parent)) parent[Number(key)] = structuredClone(op.value);
      else parent[key] = structuredClone(op.value);
      break;
    }
    case "move": { const v = get(next, op.from); del(op.from); put(op.path, v); break; }
    case "copy": put(op.path, structuredClone(get(next, op.from))); break;
    case "test":
      if (JSON.stringify(get(next, op.path)) !== JSON.stringify(op.value)) throw new Error(`test failed: ${op.path}`);
  }
  return next;
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
