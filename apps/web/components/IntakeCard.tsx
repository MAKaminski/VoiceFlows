"use client";
import { gateway } from "@/lib/gateway";
import { useEffect, useState, type FormEvent } from "react";

const KEY = "lc.intakeDismissed";

/**
 * Quick start (ADR 0021): three optional questions on a brand-new project. Answers seed the title and notes,
 * and named systems become architecture components — so the views have something to scaffold from. Skippable;
 * after the first dismiss it stays away in this browser.
 */
export function IntakeCard() {
  const [hidden, setHidden] = useState(true);
  const [f, setF] = useState({ building: "", users: "", systems: "" });
  useEffect(() => { try { setHidden(localStorage.getItem(KEY) === "1"); } catch { setHidden(false); } }, []);
  if (hidden) return null;
  const close = () => { setHidden(true); try { localStorage.setItem(KEY, "1"); } catch {} };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.building || f.users || f.systems) gateway.send({ type: "intake", ...Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim())) });
    close();
  };
  const input = { font: "inherit", fontSize: 14, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit", width: "100%" } as const;
  return (
    <form data-testid="intake" onSubmit={submit} style={{ margin: "12px 24px 0", padding: 16, borderRadius: 14, border: "1px solid var(--lc-chrome-border)", display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr auto", alignItems: "end" }}>
      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong>Quick start</strong>
        <span style={{ fontSize: 13, opacity: 0.7 }}>Optional — or just start talking. Answers seed all six views.</span>
        <button type="button" onClick={close} style={{ marginLeft: "auto", font: "inherit", fontSize: 13, border: "none", background: "transparent", color: "inherit", cursor: "pointer", opacity: 0.7 }}>Skip</button>
      </div>
      <label style={{ fontSize: 12, display: "grid", gap: 4 }}>What are you building?<input style={input} value={f.building} onChange={(e) => setF({ ...f, building: e.target.value })} placeholder="a customer support desk" /></label>
      <label style={{ fontSize: 12, display: "grid", gap: 4 }}>Who uses it?<input style={input} value={f.users} onChange={(e) => setF({ ...f, users: e.target.value })} placeholder="agents and customers" /></label>
      <label style={{ fontSize: 12, display: "grid", gap: 4 }}>Systems it must work with?<input style={input} value={f.systems} onChange={(e) => setF({ ...f, systems: e.target.value })} placeholder="Salesforce, Genesys, Slack" /></label>
      <button type="submit" data-testid="intake-go" style={{ font: "inherit", fontWeight: 600, padding: "9px 16px", borderRadius: 999, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer" }}>Start</button>
    </form>
  );
}
