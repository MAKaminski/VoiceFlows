import { describe, expect, it } from "vitest";
import {
  applyOp, architectureDoc, DesignDocSchema, docKind, emptyDoc, erdDoc, expandCompact, findNode, kitchenSinkDoc, layoutDiagram,
  defaultFlags, emptyProject, fromProjectPath, isConfirm, kindFeature, lexicon, mapOpPaths, toProject, toProjectPath, viewDoc, withView, parseDefine, sequenceDoc, type CompactContext, type DesignDoc, type Rect, type VocabTerm,
} from "../src/index.js";

const valid = (d: DesignDoc) => DesignDocSchema.safeParse(d);
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function ctxFor(doc: () => DesignDoc): CompactContext {
  const aliases = new Map<string, string>();
  const idOf = (ref: string) => aliases.get(ref) ?? (findNode(doc().root, ref) ? ref : null);
  return {
    resolve: (ref) => (ref === "root" ? "/root" : findNode(doc().root, aliases.get(ref) ?? ref)?.path ?? null),
    assignId: (alias) => { const id = `n_${alias}`; aliases.set(alias, id); return id; },
    idOf,
  };
}

/** Replays a sentence word by word through the lexicon, like STT partials, on a project (ADR 0016):
 *  a `view` result switches the active view and re-runs there. Returns the active view doc. */
function speak(sentence: string, start: DesignDoc = emptyDoc()) {
  let project = toProject(start);
  let view = docKind(start);
  const drawn = new Set<string>();
  const words = sentence.split(" ");
  for (let n = 1; n <= words.length; n++) {
    let r = lexicon(words.slice(0, n).join(" "), viewDoc(project, view), drawn);
    if (r.view) { view = r.view; r = lexicon(words.slice(0, n).join(" "), viewDoc(project, view), drawn); }
    let d = viewDoc(project, view);
    for (const op of r.ops) d = applyOp(d, op);
    project = withView(project, view, d.root);
    r.consumed.forEach((k) => drawn.add(k));
    expect(valid(project).success).toBe(true);
  }
  lastProject = project;
  return viewDoc(project, view);
}
let lastProject: DesignDoc;
const labelsIn = (doc: DesignDoc, laneId: string) => findNode(doc.root, laneId)!.node.children!.map((c) => c.props.label);

describe("diagram docs (ADR 0011)", () => {
  it("fixtures for all three kinds validate", () => {
    for (const d of [architectureDoc, erdDoc, sequenceDoc]) expect(valid(d).success).toBe(true);
  });

  it("seeds the four architecture lanes; ERD and sequence start empty", () => {
    const a = emptyDoc({ kind: "architecture" });
    expect(a.root.children!.map((c) => c.props.label)).toEqual(["Frontend", "APIs", "Database", "Infrastructure"]);
    expect(emptyDoc({ kind: "erd" }).root.children).toEqual([]);
    expect(docKind(emptyDoc({ kind: "sequence" }))).toBe("sequence");
    expect(docKind(emptyDoc())).toBe("screen");
  });

  it("never mixes screen and diagram primitives", () => {
    const d = structuredClone(architectureDoc);
    d.root.children![0]!.children!.push({ id: "n_btn", type: "Button", props: { label: "x" } });
    expect(valid(d).success).toBe(false);
    const s = structuredClone(kitchenSinkDoc);
    s.root.children!.push({ id: "n_x", type: "Node", props: { label: "x" } });
    expect(valid(s).success).toBe(false);
    const loose = structuredClone(architectureDoc);
    loose.root.children!.push({ id: "n_loose", type: "Node", props: { label: "loose" } }); // arch nodes live in lanes
    expect(valid(loose).success).toBe(false);
  });

  it("rejects an edge whose endpoint does not exist", () => {
    const d = structuredClone(erdDoc);
    d.root.children!.push({ id: "n_bad", type: "Edge", props: { from: "n_users", to: "n_ghost" } });
    expect(valid(d).success).toBe(false);
  });
});

describe("compact format for diagrams", () => {
  it("resolves edge aliases to ids and keeps single columns as arrays", () => {
    let doc = emptyDoc({ kind: "erd" });
    const ctx = ctxFor(() => doc);
    for (const line of [
      `+Node users >root k=entity cols=id:uuid:pk "users"`,
      `+Node orders >root k=entity cols=id:uuid:pk,user_id:uuid:fk,total:numeric "orders"`,
      `+Edge r1 >root from=users to=orders card=1:n "places"`,
    ]) for (const op of expandCompact(line, ctx)) doc = applyOp(doc, op);
    expect(valid(doc).success).toBe(true);
    expect(findNode(doc.root, "n_users")!.node.props.cols).toEqual(["id:uuid:pk"]);
    expect(findNode(doc.root, "n_r1")!.node.props).toMatchObject({ from: "n_users", to: "n_orders", card: "1:n", label: "places" });
  });

  it("an edge to an unknown node is a parse error, not a dangling edge", () => {
    const doc = emptyDoc({ kind: "sequence" });
    expect(() => expandCompact(`+Edge m >root from=ghost to=api "x"`, ctxFor(() => doc))).toThrow();
  });
});

describe("diagram lexicon", () => {
  it("switches a blank screen to an architecture diagram and files components into lanes", () => {
    const doc = speak("an architecture diagram with a next js web app a fastify api postgres and redis deployed on railway");
    expect(docKind(doc)).toBe("architecture");
    expect(labelsIn(doc, "n_frontend")).toEqual(["Web app"]);
    expect(labelsIn(doc, "n_api")).toEqual(["API"]);
    expect(labelsIn(doc, "n_data")).toEqual(["Postgres", "Redis"]);
    expect(labelsIn(doc, "n_infra")).toEqual(["Railway"]);
  });

  it("draws entities for an ERD, including '<word> table'", () => {
    const doc = speak("an erd with users orders and a leads table where each user has many orders");
    expect(docKind(doc)).toBe("erd");
    expect(doc.root.children!.map((c) => c.props.label)).toEqual(["users", "orders", "leads"]);
  });

  it("draws sequence participants in the order spoken, once each", () => {
    const doc = speak("a sequence diagram where the user opens the web app the app calls the api and the api queries postgres");
    expect(doc.root.children!.map((c) => c.props.label)).toEqual(["User", "Web app", "API", "Postgres"]);
  });

  it("a loose phrase never leaves a view with content; a strong one switches without touching it", () => {
    const arch = speak("architecture with postgres");
    expect(lexicon("and a database schema", arch).view).toBeUndefined();
    expect(lexicon("now the erd with users", arch).view).toBe("erd");
  });

  it("leaves screen mode alone", () => {
    const doc = speak("a login screen with email and password");
    expect(docKind(doc)).toBe("screen");
  });
});

describe("layout", () => {
  for (const d of [architectureDoc, erdDoc, sequenceDoc]) {
    it(`${d.root.props.kind}: no two boxes overlap and every edge is routed`, () => {
      const l = layoutDiagram(d)!;
      const rects = Object.values(l.nodes);
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      const edges = d.root.children!.filter((c) => c.type === "Edge");
      expect(l.edges.map((e) => e.id).sort()).toEqual(edges.map((e) => e.id).sort());
      for (const e of l.edges) {
        expect(e.d.startsWith("M")).toBe(true);
        for (const [x, y] of e.points) { expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(l.width); expect(y).toBeLessThanOrEqual(l.height); }
      }
    });
  }

  it("architecture edges never pass through a box they don't connect", () => {
    const l = layoutDiagram(architectureDoc)!;
    for (const e of l.edges) {
      for (const [id, r] of Object.entries(l.nodes)) {
        if (id === e.from || id === e.to) continue;
        const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
        for (let i = 0; i < e.points.length - 1; i++) {
          const [a, b] = [e.points[i]!, e.points[i + 1]!];
          const seg = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]) || 0.01, h: Math.abs(a[1] - b[1]) || 0.01 };
          expect(overlaps(seg, inner), `${e.id} crosses ${id}`).toBe(false);
        }
      }
    }
  });

  it("is append-stable: adding a node or edge never moves anything already drawn", () => {
    for (const [d, add] of [
      [architectureDoc, (x: DesignDoc) => applyOp(x, { op: "add", path: "/root/children/2/children/2", value: { id: "n_new", type: "Node", props: { label: "S3", kind: "storage" } } })],
      [erdDoc, (x: DesignDoc) => applyOp(x, { op: "add", path: "/root/children/4", value: { id: "n_new", type: "Node", props: { label: "teams", kind: "entity", cols: ["id:uuid:pk"] } } })],
      [sequenceDoc, (x: DesignDoc) => applyOp(x, { op: "add", path: "/root/children/5", value: { id: "n_new", type: "Node", props: { label: "Redis", kind: "cache" } } })],
    ] as const) {
      const before = layoutDiagram(d)!;
      const after = layoutDiagram(add(d))!;
      for (const [id, r] of Object.entries(before.nodes)) expect(after.nodes[id], `${d.root.props.kind} ${id}`).toEqual(r);
    }
  });
});

describe("live-run regressions (2026-09-27)", () => {
  it("ignores ?provisional echoed back on a + line", () => {
    const doc = emptyDoc({ kind: "sequence" });
    const [op] = expandCompact(`+Node n_p_user >root k=user "User" ?provisional`, ctxFor(() => doc));
    expect(valid(applyOp(doc, op!)).success).toBe(true);
  });
});

describe("vocabulary (ADR 0012)", () => {
  it("parses define commands onto known kind words only", () => {
    expect(parseDefine("define kafka as a queue", "architecture")).toEqual({ phrase: "kafka", node: { label: "Kafka", kind: "queue", tier: "api" } });
    expect(parseDefine("so treat billing service as an external", "architecture")?.node).toEqual({ label: "Billing Service", kind: "external", tier: "api" });
    expect(parseDefine("define ledger as a table", "erd")).toEqual({ phrase: "ledger", node: { label: "ledger", kind: "entity" } });
    expect(parseDefine("the api should define kafka as a queue", "architecture")).toBeNull(); // commands start the utterance
    expect(parseDefine("define kafka as a banana", "architecture")).toBeNull();
    expect(parseDefine("the api calls postgres", "architecture")).toBeNull();
    expect(isConfirm("yes confirm")).toBe(true);
    expect(isConfirm("lock it in.")).toBe(true);
    expect(isConfirm("confirm the email is sent")).toBe(false);
  });

  it("a confirmed user word draws like a built-in and wins over it; proposed words don't draw", () => {
    const terms: VocabTerm[] = [
      { id: "t1", kind: "architecture", phrase: "ledger", node: { label: "Ledger", kind: "db", tier: "data" }, status: "confirmed" },
      { id: "t2", kind: "architecture", phrase: "redis", node: { label: "Session store", kind: "cache", tier: "data" }, status: "confirmed" },
      { id: "t3", kind: "architecture", phrase: "nimbus", node: { label: "Nimbus", kind: "service", tier: "infra" }, status: "proposed" },
    ];
    const doc = emptyDoc({ kind: "architecture" });
    const r = lexicon("the api writes to the ledger and redis on nimbus", doc, new Set(), terms);
    let d = doc; for (const op of r.ops) d = applyOp(d, op);
    expect(labelsIn(d, "n_data")).toEqual(["Ledger", "Session store"]);
    expect(labelsIn(d, "n_infra")).toEqual([]);
  });

  it("a define command draws nothing", () => {
    expect(lexicon("define kafka as a queue", emptyDoc({ kind: "architecture" })).ops).toEqual([]);
  });

  it("feature registry: every key has a default; diagram kinds map to their flag", () => {
    expect(defaultFlags().speak_to_create).toBe(true);
    expect(defaultFlags().diagram_metrics).toBe(false);
    expect(kindFeature("erd")).toBe("diagram_erd");
    expect(kindFeature("screen")).toBe("speak_to_create");
  });
});

describe("transcript highlighting support (ADR 0012)", () => {
  it("lexicon results carry the noun's occurrence key and whether it was the user's word", () => {
    const terms: VocabTerm[] = [{ id: "t", kind: "architecture", phrase: "ledger", node: { label: "Ledger", kind: "db", tier: "data" }, status: "confirmed" }];
    const r = lexicon("the api writes to the ledger and postgres", emptyDoc({ kind: "architecture" }), new Set(), terms);
    expect(r.created.map((c) => [c.key, !!c.mine])).toEqual([["api#1", false], ["ledger#1", true], ["postgres#1", false]]);
    const s = lexicon("a big blue sign in button", emptyDoc());
    expect(s.created[0]!.key).toBe("button#1");
    expect(s.consumed).toEqual(expect.arrayContaining(["button#1", "big#1", "blue#1"]));
  });
});

describe("projects (ADR 0016)", () => {
  it("every fixture upgrades to a valid project, idempotently, keeping its view", () => {
    for (const d of [architectureDoc, erdDoc, sequenceDoc, kitchenSinkDoc, emptyDoc()]) {
      const p = toProject(d);
      expect(valid(p).success).toBe(true);
      expect(toProject(p)).toBe(p);
      expect(viewDoc(p, docKind(d)).root.children).toEqual(d.root.children);
    }
    expect(valid(emptyProject()).success).toBe(true);
  });

  it("naming another view mid-sentence keeps what was drawn in the first view", () => {
    const erd = speak("an architecture with a fastify api and postgres and then the erd with users and orders");
    expect(docKind(erd)).toBe("erd");
    expect(erd.root.children!.map((c) => c.props.label)).toEqual(["users", "orders"]);
    const arch = viewDoc(lastProject, "architecture");
    expect(JSON.stringify(arch)).toContain('"Postgres"');
    expect(JSON.stringify(arch)).toContain('"API"');
  });

  it("path rewrite round-trips, including move ops", () => {
    const op = { op: "move" as const, from: "/root/children/0/children/1", path: "/root/children/2/children/-" };
    const up = mapOpPaths(op, (p) => toProjectPath(p, "architecture"));
    expect(up).toEqual({ op: "move", from: "/root/children/1/children/0/children/1", path: "/root/children/1/children/2/children/-" });
    expect(mapOpPaths(up, (p) => fromProjectPath(p, "architecture")!)).toEqual(op);
    expect(toProjectPath("/root", "erd")).toBe("/root/children/2");
    expect(fromProjectPath("/root/children/3/children/0", "erd")).toBeNull();
  });

  it("ids stay unique across views: the lexicon avoids ids used in other views", () => {
    const seq = lexicon("the api", emptyDoc({ kind: "sequence" }), new Set(), [], () => true, new Set(["n_p_api"]));
    expect(seq.created[0]!.id).toBe("n_p_api_2");
    const p = withView(withView(emptyProject(), "architecture", { ...architectureDoc.root, id: "n_view_architecture" }), "sequence", { ...sequenceDoc.root, id: "n_view_sequence" });
    expect(valid(p).success).toBe(true);
    const clash = withView(p, "erd", { id: "n_view_erd", type: "Diagram", props: { kind: "erd" }, children: [{ id: "n_gateway", type: "Node", props: { label: "x", kind: "entity" } }] });
    expect(valid(clash).success).toBe(false); // n_gateway is already in the architecture
  });

  it("enterprise systems draw in the right lane from the lexicon alone", () => {
    const d = speak("an architecture where mulesoft connects salesforce and genesys with a genesys bot and observe ai");
    expect(labelsIn(d, "n_api")).toEqual(["MuleSoft", "Salesforce", "Genesys", "Genesys bot", "Observe.AI"]);
  });
});
