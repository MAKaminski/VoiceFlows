import { describe, expect, it } from "vitest";
import { applyOp, emptyDoc, Flags, isSaveCommand, isSuggestionCommand, lexicon, parseSave, resolveCommand, ruleSuggestions, type DesignDoc, type Suggestion } from "../src/index.js";

const draw = (text: string, doc: DesignDoc) => { let d = doc; for (const op of lexicon(text, d).ops) d = applyOp(d, op); return d; };

describe("implied suggestions (ADR 0020)", () => {
  it("a cases table is offered subject, status, priority, created_at at once", () => {
    const d = draw("customers and cases", emptyDoc({ kind: "erd" }));
    const s = ruleSuggestions(d, "erd");
    const cases = s.find((x) => x.target === "n_p_cases")!;
    expect(cases.cols).toEqual(["subject:text", "status:text", "priority:text", "created_at:timestamptz"]);
    expect(s.find((x) => x.target === "n_p_customers")!.cols).toContain("email:text");
  });

  it("columns the table already has are not suggested", () => {
    let d = draw("users", emptyDoc({ kind: "erd" }));
    d = applyOp(d, { op: "replace", path: "/root/children/0/props/cols", value: ["id:uuid:pk", "email:text"] });
    expect(ruleSuggestions(d, "erd")[0]!.cols).toEqual(["name:text", "created_at:timestamptz"]);
  });

  it("a login screen with a password is offered a forgot-password link; architecture gets Auth", () => {
    const s = ruleSuggestions(draw("a login screen with email and password", emptyDoc()), "screen");
    expect(s.map((x) => x.id)).toContain("screen:forgot");
    const a = ruleSuggestions(draw("a web app calls an api", emptyDoc({ kind: "architecture" })), "architecture");
    expect(a.map((x) => x.id)).toEqual(["arch:auth"]);
  });

  it("recognises commands at the start of an utterance only", () => {
    expect(isSuggestionCommand("approve")).toBe(true);
    expect(isSuggestionCommand("ok approve all but status")).toBe(true);
    expect(isSuggestionCommand("the approve button")).toBe(false);
    expect(isSaveCommand("save the project")).toBe(true);
    expect(isSaveCommand("save button")).toBe(false);
    expect(parseSave("save it as contact center")).toEqual({ title: "Contact Center" });
  });

  const items: Suggestion[] = [
    { id: "cols:n_cases", view: "erd", source: "rule", target: "n_cases", title: "cases: subject, status, priority", cols: ["subject:text", "status:text", "priority:text"] },
    { id: "arch:auth", view: "architecture", source: "rule", title: "Auth service for API", lines: [] },
  ];
  it("resolves scoped commands deterministically", () => {
    expect(resolveCommand("approve", items)).toMatchObject({ verb: "approve", picks: [{ id: "cols:n_cases" }, { id: "arch:auth" }], unresolved: false });
    expect(resolveCommand("approve the case columns", items).picks).toEqual([{ id: "cols:n_cases" }]);
    expect(resolveCommand("approve all but status", items).picks).toEqual([{ id: "cols:n_cases", cols: ["subject:text", "priority:text"] }, { id: "arch:auth" }]);
    expect(resolveCommand("reject the auth one", items)).toMatchObject({ verb: "reject", picks: [{ id: "arch:auth" }] });
    expect(resolveCommand("approve priority", items).picks).toEqual([{ id: "cols:n_cases", cols: ["priority:text"] }]);
    expect(resolveCommand("approve the widget thing", items).unresolved).toBe(true);
  });

  it("flag parsing is tolerant: unknown keys ignored, missing ones default (deploy safety)", () => {
    const f = Flags.parse({ projects: false, some_future_flag: true });
    expect(f.projects).toBe(false);
    expect(f.all_views).toBe(true);
    expect("some_future_flag" in f).toBe(false);
  });
});
