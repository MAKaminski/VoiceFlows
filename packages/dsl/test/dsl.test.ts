import { describe, expect, it } from "vitest";
import {
  applyOp, CompactParseError, DesignDocSchema, deltaScore, emptyDoc, expandCompact, findNode,
  invertOp, kitchenSinkDoc, PatchOp, PRIMITIVE_TYPES, type CompactContext, type DesignDoc, type Intent,
} from "../src/index.js";

function ctxFor(doc: DesignDoc): CompactContext & { aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  let n = 0;
  return {
    aliases,
    resolve: (ref) => (ref === "root" ? "/root" : findNode(doc.root, aliases.get(ref) ?? ref)?.path ?? null),
    assignId: (alias) => {
      const id = `n_${alias.toLowerCase().replace(/[^a-z0-9]/g, "")}${n++}`;
      aliases.set(alias, id);
      return id;
    },
  };
}

describe("DesignDoc", () => {
  it("kitchen-sink fixture validates and uses all 12 primitives", () => {
    expect(DesignDocSchema.safeParse(kitchenSinkDoc).success).toBe(true);
    const seen = new Set<string>();
    const walk = (n: DesignDoc["root"]) => { seen.add(n.type); n.children?.forEach(walk); };
    walk(kitchenSinkDoc.root);
    expect([...seen].sort()).toEqual([...PRIMITIVE_TYPES].sort());
  });

  it("rejects raw hex in props and children on leaf primitives", () => {
    const bad = emptyDoc();
    bad.root.children = [{ id: "n_t", type: "Text", props: { content: "x", color: "#ff0000" } }];
    expect(DesignDocSchema.safeParse(bad).success).toBe(false);
    bad.root.children = [{ id: "n_b", type: "Button", props: { label: "x" }, children: [] }];
    expect(DesignDocSchema.safeParse(bad).success).toBe(false);
  });
});

describe("compact → RFC 6902", () => {
  it("expands add/replace/remove/move and the result validates", () => {
    let doc = emptyDoc();
    const ctx = ctxFor(doc);
    const run = (line: string) => {
      ctx.resolve = (ref) => (ref === "root" ? "/root" : findNode(doc.root, ctx.aliases.get(ref) ?? ref)?.path ?? null);
      for (const op of expandCompact(line, ctx, () => "Button")) {
        expect(PatchOp.safeParse(op).success).toBe(true);
        doc = applyOp(doc, op);
      }
    };
    run(`+Image logo >root alt=Logo aspect=1:1`);
    run(`+Button signin >root v=primary s=lg "Sign in"`);
    run(`~signin c=primary label="Log in"`);
    run(`^signin >root @0`);
    expect(doc.root.children?.map((c) => c.type)).toEqual(["Button", "Image"]);
    expect(doc.root.children?.[0]?.props).toEqual({ variant: "primary", size: "lg", label: "Log in", color: "primary" });
    run(`-logo`);
    expect(doc.root.children).toHaveLength(1);
    expect(DesignDocSchema.safeParse(doc).success).toBe(true);
  });

  it("compact line is much shorter than the JSON Patch it replaces", () => {
    const line = `+Button signin >root v=primary s=lg "Sign in"`;
    const [op] = expandCompact(line, ctxFor(emptyDoc()));
    expect(line.length * 2).toBeLessThan(JSON.stringify(op).length);
  });

  it("throws on unknown primitive, unknown ref, and bad sigil", () => {
    const ctx = ctxFor(emptyDoc());
    expect(() => expandCompact(`+Widget w >root`, ctx)).toThrow(CompactParseError);
    expect(() => expandCompact(`~ghost v=primary`, ctx)).toThrow(CompactParseError);
    expect(() => expandCompact(`*root`, ctx)).toThrow(CompactParseError);
  });
});

describe("applyOp / invertOp", () => {
  it("inverse ops restore the exact prior doc (undo contract)", () => {
    const before = structuredClone(kitchenSinkDoc);
    const ops: PatchOp[] = [
      { op: "add", path: "/root/children/-", value: { id: "n_new", type: "Text", props: { content: "hi" } } },
      { op: "replace", path: "/root/children/2/props/content", value: "Hello" },
      { op: "remove", path: "/root/children/0" },
      { op: "move", from: "/root/children/0", path: "/root/children/3" },
    ];
    let doc = before;
    const inverses: PatchOp[] = [];
    for (const op of ops) { inverses.unshift(invertOp(doc, op)); doc = applyOp(doc, op); }
    for (const inv of inverses) doc = applyOp(doc, inv);
    expect(doc).toEqual(kitchenSinkDoc);
  });
});

describe("deltaScore", () => {
  const base: Intent = { action: "add", targets: [{ ref: "signin", primitive: "Button" }], attributes: { color: "primary" }, structural: false, explicit_command: false, confidence: 0.9 };
  it("is 0 for identical intents and ≥ commit threshold for a new target", () => {
    expect(deltaScore(base, base)).toBe(0);
    expect(deltaScore({ ...base, targets: [...base.targets, { ref: "logo", primitive: "Image" }] }, base)).toBeGreaterThanOrEqual(0.3);
    expect(deltaScore({ ...base, action: "restyle", attributes: { size: "lg" } }, base)).toBeCloseTo(0.55);
  });
});
