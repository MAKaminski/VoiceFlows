"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { useDoc } from "@/store/doc";
import { architectureDoc, erdDoc, kitchenSinkDoc, PRIMITIVE_TYPES, sequenceDoc, type DesignDoc } from "@livecanvas/dsl";
import { useEffect, useState } from "react";

const FIXTURES: Record<string, DesignDoc> = { screen: kitchenSinkDoc, architecture: architectureDoc, erd: erdDoc, sequence: sequenceDoc };

/** Static fixtures, no gateway: `?kind=architecture|erd|sequence` — also the source of golden screenshots. */
export default function Playground() {
  const { doc, setDoc } = useDoc();
  const [kind, setKind] = useState("screen");
  useEffect(() => { const k = new URLSearchParams(location.search).get("kind"); if (k && FIXTURES[k]) setKind(k); }, []);
  useEffect(() => setDoc(FIXTURES[kind]!), [kind, setDoc]);

  return (
    <main>
      <header style={{ padding: "16px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>LiveCanvas · playground</strong>
        <a href="/studio" style={{ fontWeight: 600, color: "#2563eb", textDecoration: "none" }}>Open the studio →</a>
        {Object.keys(FIXTURES).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} style={{ font: "inherit", fontSize: 13, fontWeight: kind === k ? 700 : 400, background: "none", border: "none", cursor: "pointer", textDecoration: kind === k ? "underline" : "none" }}>{k}</button>
        ))}
        <span style={{ fontSize: 13, opacity: 0.7 }}>{PRIMITIVE_TYPES.length} primitives: {PRIMITIVE_TYPES.join(" · ")}</span>
      </header>
      <Canvas doc={doc} />
    </main>
  );
}
