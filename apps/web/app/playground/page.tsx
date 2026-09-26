"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { useDoc } from "@/store/doc";
import { kitchenSinkDoc, PRIMITIVE_TYPES } from "@livecanvas/dsl";
import { useEffect } from "react";

export default function Playground() {
  const { doc, setDoc } = useDoc();
  useEffect(() => setDoc(kitchenSinkDoc), [setDoc]);

  return (
    <main>
      <header style={{ padding: "16px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>LiveCanvas · playground</strong>
        <span style={{ fontSize: 13, opacity: 0.7 }}>{PRIMITIVE_TYPES.length} primitives: {PRIMITIVE_TYPES.join(" · ")}</span>
      </header>
      <Canvas doc={doc} />
    </main>
  );
}
