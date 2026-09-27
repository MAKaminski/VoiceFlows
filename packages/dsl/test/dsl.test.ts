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
    run(`+Text hint >root "Tap to begin" @0`);
    expect(doc.root.children?.[0]?.props).toEqual({ content: "Tap to begin" });
    run(`-hint`);
    expect(doc.root.children?.map((c) => c.type)).toEqual(["Button", "Image"]);
    expect(doc.root.children?.[0]?.props).toEqual({ variant: "primary", size: "lg", label: "Log in", color: "primary" });
    run(`-logo`);
    expect(doc.root.children).toHaveLength(1);
    expect(DesignDocSchema.safeParse(doc).success).toBe(true);
  });

  it("new containers accept children, and a stray label on a container is ignored (M3 live bug)", () => {
    let doc = emptyDoc();
    const ctx = ctxFor(doc);
    const run = (line: string) => {
      ctx.resolve = (ref) => (ref === "root" ? "/root" : findNode(doc.root, ctx.aliases.get(ref) ?? ref)?.path ?? null);
      for (const op of expandCompact(line, ctx)) doc = applyOp(doc, op);
    };
    run(`+Card form >root p=lg "Login Form"`);
    run(`+Input email >form k=email "Email"`);
    run(`+Button signin >form v=primary "Sign in"`);
    const form = doc.root.children![0]!;
    expect(form).toMatchObject({ type: "Card", props: { padding: "lg" } });
    expect(form.children!.map((c) => c.type)).toEqual(["Input", "Button"]);
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

describe("applyOp structural sharing (F1)", () => {
  const deepFreeze = (o: any): any => { Object.values(o).forEach((v) => v && typeof v === "object" && deepFreeze(v)); return Object.freeze(o); };
  it("never mutates the input and keeps untouched subtrees identical", () => {
    const before = deepFreeze(structuredClone(kitchenSinkDoc));
    const after = applyOp(before, { op: "replace", path: "/root/children/4/children/0/children/2/props/label", value: "Log in" });
    expect(before.root.children[4].children[0].children[2].props.label).toBe("Sign in");
    expect(after.root.children[4].children[0].children[2].props.label).toBe("Log in");
    // siblings off the path keep identity → React.memo skips them
    expect(after.root.children[0]).toBe(before.root.children[0]);
    expect(after.root.children[5]).toBe(before.root.children[5]);
    expect(after.root.children[4].children[0].children[0]).toBe(before.root.children[4].children[0].children[0]);
    // nodes on the path are new objects
    expect(after.root.children[4]).not.toBe(before.root.children[4]);
  });
  it("rejects out-of-range indices and missing targets", () => {
    expect(() => applyOp(kitchenSinkDoc, { op: "remove", path: "/root/children/99" })).toThrow();
    expect(() => applyOp(kitchenSinkDoc, { op: "replace", path: "/root/children/99/props/x", value: 1 })).toThrow();
    expect(() => applyOp(kitchenSinkDoc, { op: "add", path: "/root/children/2.5", value: {} })).toThrow();
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

describe("serializeCompact", () => {
  it("is ≥ 1.8× smaller than the JSON doc (measured 1.83×) and lists every node once", async () => {
    const { serializeCompact } = await import("../src/index.js");
    const text = serializeCompact(kitchenSinkDoc.root);
    const lines = text.split("\n");
    const count = (n: DesignDoc["root"]): number => 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0);
    expect(lines).toHaveLength(count(kitchenSinkDoc.root) - 1); // root is implicit
    expect(text.length * 1.8).toBeLessThan(JSON.stringify(kitchenSinkDoc).length);
    expect(lines.find((l) => l.startsWith("+Button n_signin"))).toBe(`+Button n_signin >n_fields v=primary s=lg "Sign in"`);
  });
});

describe("parseHeader (compressed intent header, ADR 0006)", async () => {
  const { parseHeader } = await import("../src/index.js");
  it("parses action, confidence, flags and targets", () => {
    expect(parseHeader("add .9 signin logo")).toEqual({ a: "add", c: 0.9, s: false, x: false, t: ["signin", "logo"] });
    expect(parseHeader("layout .8 s")).toEqual({ a: "layout", c: 0.8, s: true, x: false, t: [] });
    expect(parseHeader("undo 1 x")).toEqual({ a: "undo", c: 1, s: false, x: true, t: [] });
    expect(parseHeader("none 0")).toEqual({ a: "none", c: 0, s: false, x: false, t: [] });
  });
  it("accepts the legacy JSON header and rejects op lines", () => {
    expect(parseHeader('{"a":"add","t":["x"],"c":0.9,"s":false,"x":false}')?.a).toBe("add");
    expect(parseHeader('+Button signin >root "Sign in"')).toBeNull();
    expect(parseHeader("add 7")).toBeNull();
  });
});

describe("lexicon (M4 tier 0)", async () => {
  const { lexicon } = await import("../src/lexicon.js");
  const SENTENCE = "a login screen with email and password big blue sign in button logo on top";

  /** Replays the sentence as growing partials (as Flux sends them), applying ops each time. */
  function replay(sentence: string, start = emptyDoc()) {
    let doc = start;
    const batches: string[][] = [];
    const moves: Record<string, number> = {};
    const words = sentence.split(" ");
    for (let n = 1; n <= words.length; n++) {
      const before = new Map((doc.root.children ?? []).map((c, i) => [c.id, i]));
      const r = lexicon(words.slice(0, n).join(" "), doc);
      for (const op of r.ops) doc = applyOp(doc, op);
      if (r.created.length) batches.push(r.created.map((c) => c.id));
      (doc.root.children ?? []).forEach((c, i) => { if (before.has(c.id) && before.get(c.id)! !== i) moves[c.id] = (moves[c.id] ?? 0) + 1; });
    }
    return { doc, batches, moves };
  }

  it("draws the definition-of-done sentence in order, with held modifiers and the button label", () => {
    const { doc, batches } = replay(SENTENCE);
    expect(batches).toEqual([["n_p_email"], ["n_p_password"], ["n_p_button"], ["n_p_logo"]]);
    expect(doc.root.children!.map((c) => [c.type, c.props])).toEqual([
      ["Image", { alt: "Logo", aspect: "3:1" }],
      ["Input", { label: "Email", kind: "email", placeholder: "you@example.com" }],
      ["Input", { label: "Password", kind: "password" }],
      ["Button", { label: "Sign in", variant: "primary", size: "lg", color: "primary" }],
    ]);
    expect(doc.root.children!.every((c) => c.provisional === true)).toBe(true);
    expect(DesignDocSchema.safeParse(doc).success).toBe(true);
  });

  it("never duplicates across partials, mentions, or edits of existing elements", () => {
    const { doc } = replay(`${SENTENCE} and make the email field bigger and the button blue`);
    expect(doc.root.children).toHaveLength(4);
    const again = lexicon("an email and a password", doc);
    expect(again.ops).toEqual([]);
  });

  it("each element moves at most once (logo inserted by rank, not appended then moved)", () => {
    const { moves } = replay(SENTENCE);
    expect(Math.max(0, ...Object.values(moves))).toBeLessThanOrEqual(1);
  });

  it("ignores filler and uses doc kinds built by the model, not just provisional ones", () => {
    expect(lexicon("um so like a", emptyDoc()).ops).toEqual([]);
    const built = emptyDoc();
    built.root.children = [{ id: "n_email", type: "Input", props: { label: "Email", kind: "email" } }];
    expect(lexicon("email", built).ops).toEqual([]);
  });
});
