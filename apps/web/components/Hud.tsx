"use client";
import { gateway } from "@/lib/gateway";
import { pct, useMetrics } from "@/store/metrics";
import { useVoice } from "@/store/voice";
import { useState } from "react";

const TARGET = { ttfv0: 400, ttfv1: 1000, settle: 1200 } as const;

function Row({ label, xs, target }: { label: string; xs: number[]; target?: number }) {
  const p50 = pct(xs, 50), p95 = pct(xs, 95);
  const ok = p50 == null || target == null ? undefined : p50 <= target;
  return (
    <tr>
      <td>{label}</td>
      <td style={{ textAlign: "right", color: ok === false ? "#dc2626" : ok ? "#16a34a" : undefined, fontWeight: 600 }}>{p50 ?? "—"}</td>
      <td style={{ textAlign: "right" }}>{p95 ?? "—"}</td>
      <td style={{ textAlign: "right", opacity: 0.6 }}>{target ? `≤ ${target}` : ""}</td>
      <td style={{ textAlign: "right", opacity: 0.6 }}>n={xs.length}</td>
    </tr>
  );
}

/** Dev latency HUD (`/studio?hud`): client-measured TTFV, settle, reflows, calls, cost, tunables. */
export function Hud() {
  const m = useMetrics();
  const frames = useVoice((s) => s.framesSent);
  const [gap, setGap] = useState(150);
  const [cap, setCap] = useState(20);
  const speakingMin = (frames * 80) / 60_000;
  const perMin = (v: number) => (speakingMin > 0.05 ? v / speakingMin : null);
  const callsPerMin = perMin(m.modelCalls), dollarsPerMin = perMin(m.dollars);
  return (
    <aside data-testid="hud" style={{ position: "fixed", right: 16, top: 96, width: 330, zIndex: 10, background: "rgba(15,23,42,.92)", color: "#e2e8f0",
      borderRadius: 12, padding: 14, font: "12px ui-monospace, SFMono-Regular, Menlo, monospace", fontVariantNumeric: "tabular-nums", boxShadow: "0 10px 30px rgba(0,0,0,.3)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><strong>Latency HUD</strong><button onClick={m.reset} style={{ font: "inherit", background: "none", color: "inherit", border: "1px solid #475569", borderRadius: 6, cursor: "pointer" }}>reset</button></div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ opacity: 0.6 }}><td>ms</td><td style={{ textAlign: "right" }}>p50</td><td style={{ textAlign: "right" }}>p95</td><td /><td /></tr></thead>
        <tbody>
          <Row label="TTFV-0 lexicon" xs={m.ttfv0} target={TARGET.ttfv0} />
          <Row label="TTFV-1 model" xs={m.ttfv1} target={TARGET.ttfv1} />
          <Row label="settle" xs={m.settle} target={TARGET.settle} />
        </tbody>
      </table>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 8px" }}>
        <span>max reflows / element</span><strong style={{ color: Math.max(0, ...m.reflowMaxPerElement) >= 3 ? "#dc2626" : undefined }}>{m.reflowMaxPerElement.length ? Math.max(...m.reflowMaxPerElement) : "—"}</strong>
        <span>model calls / speaking min</span><strong>{callsPerMin != null ? callsPerMin.toFixed(1) : "—"}</strong>
        <span>$ / speaking min</span><strong>{dollarsPerMin != null ? `$${dollarsPerMin.toFixed(4)}` : "—"}</strong>
      </div>
      <label style={{ display: "block", marginTop: 10 }}>min gap between calls: {gap} ms
        <input type="range" min={0} max={1000} step={25} value={gap} style={{ width: "100%" }}
          onChange={(e) => { const v = Number(e.target.value); setGap(v); gateway.send({ type: "tune", minGapMs: v }); }} />
      </label>
      <label style={{ display: "block", marginTop: 6 }}>call cap: {cap} / min
        <input type="range" min={5} max={60} step={1} value={cap} style={{ width: "100%" }}
          onChange={(e) => { const v = Number(e.target.value); setCap(v); gateway.send({ type: "tune", callsPerMin: v }); }} />
      </label>
    </aside>
  );
}
