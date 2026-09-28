"use client";
import { HTTP_BASE } from "@/lib/gateway";
import { useCallback, useEffect, useState, type FormEvent } from "react";

/**
 * Admin: feature flags + 7-day usage (ADR 0012). The token stays in this tab's sessionStorage only;
 * the gateway answers /admin from the production origin alone and rate-limits failed tokens.
 */
interface Change { key: string; enabled: boolean; source: "admin" | "seed"; actor: string | null; at: string }
interface Row { key: string; description: string; default: boolean; enabled: boolean; last7d: { exposed: number; used: number; blocked: number }; lastChange?: Change | null }
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const who = (c: Change) => (c.source === "seed" ? "added with its default" : `by admin${c.actor ? ` ${c.actor}` : ""}`);
const TOKEN_KEY = "lc.adminToken";

export default function Admin() {
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Change[] | null>(null);

  useEffect(() => { try { setToken(sessionStorage.getItem(TOKEN_KEY)); } catch {} }, []);

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`${HTTP_BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers } });
    if (res.status === 401) { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} setToken(null); throw new Error("That token was rejected"); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json();
  }, [token]);

  const load = useCallback(() => {
    if (!token) return;
    call("/admin/flags").then((d) => { setRows(d.flags); setError(null); }, (e: Error) => setError(e.message));
    call("/admin/flags/history?limit=50").then((d) => setHistory(d.changes), () => setHistory(null));
  }, [call, token]);
  useEffect(load, [load]);

  const toggle = async (r: Row) => {
    setRows((rs) => rs?.map((x) => (x.key === r.key ? { ...x, enabled: !r.enabled } : x)) ?? null);
    try { await call(`/admin/flags/${r.key}`, { method: "PUT", body: JSON.stringify({ enabled: !r.enabled }) }); load(); }
    catch (e) { setError((e as Error).message); load(); }
  };

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    try { sessionStorage.setItem(TOKEN_KEY, draft); } catch {}
    setToken(draft); setDraft("");
  };

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 24px", fontSize: 14 }}>
      <a href="/studio" data-testid="back-to-studio" style={{ display: "inline-block", marginBottom: 12, fontWeight: 600, color: "#2563eb", textDecoration: "none" }}>← Studio</a>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Feature flags</h1>
      <p style={{ margin: "0 0 20px", opacity: 0.7 }}>Every feature is behind a flag. Changes apply to open sessions immediately. Usage is the last 7 days.</p>
      {!token ? (
        <form onSubmit={signIn} style={{ display: "flex", gap: 8 }}>
          <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Admin token" aria-label="Admin token" autoComplete="off"
            style={{ font: "inherit", flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--lc-chrome-border)" }} />
          <button type="submit" disabled={!draft} style={{ font: "inherit", fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "none", background: "#0f172a", color: "#fff", cursor: "pointer" }}>Open</button>
        </form>
      ) : (
        <>
          {error && <p role="alert" style={{ color: "#b91c1c" }}>{error}</p>}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", fontSize: 12, opacity: 0.7 }}>
                <th style={{ padding: "8px 6px" }}>Feature</th><th>On</th>
                <th style={{ textAlign: "right" }} title="Sessions that had the feature available">Exposed</th>
                <th style={{ textAlign: "right" }} title="Times it was used">Used</th>
                <th style={{ textAlign: "right", paddingRight: 6 }} title="Attempts while it was off">Blocked</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.key} data-testid={`flag-${r.key}`} style={{ borderTop: "1px solid var(--lc-chrome-border)" }}>
                  <td style={{ padding: "10px 6px" }}>
                    <div style={{ fontWeight: 600, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13 }}>{r.key}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{r.description}{r.enabled !== r.default ? " · changed from default" : ""}</div>
                    {r.lastChange && <div data-testid={`last-${r.key}`} style={{ fontSize: 11, opacity: 0.6 }}>Turned {r.lastChange.enabled ? "on" : "off"} {who(r.lastChange)} · {when(r.lastChange.at)}</div>}
                  </td>
                  <td>
                    <button type="button" role="switch" aria-checked={r.enabled} aria-label={`Toggle ${r.key}`} onClick={() => toggle(r)}
                      style={{ width: 40, height: 22, borderRadius: 999, border: "none", cursor: "pointer", position: "relative", background: r.enabled ? "#16a34a" : "#cbd5e1" }}>
                      <span style={{ position: "absolute", top: 3, left: r.enabled ? 21 : 3, width: 16, height: 16, borderRadius: 999, background: "#fff", transition: "left .15s" }} />
                    </button>
                  </td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.last7d.exposed}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{r.last7d.used}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", paddingRight: 6, color: r.last7d.blocked ? "#b45309" : undefined }}>{r.last7d.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 style={{ fontSize: 16, margin: "28px 0 8px" }}>History</h2>
          <p style={{ margin: "0 0 8px", opacity: 0.7, fontSize: 12 }}>Every change, newest first. “admin 3f2a9c1d” is a short fingerprint of where the change came from — never the address itself.</p>
          {!history?.length ? <p style={{ opacity: 0.6 }}>No changes recorded yet.</p> : (
            <table data-testid="flag-history" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {history.map((c, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--lc-chrome-border)" }}>
                    <td style={{ padding: "6px 6px", whiteSpace: "nowrap", opacity: 0.7 }}>{when(c.at)}</td>
                    <td style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{c.key}</td>
                    <td style={{ fontWeight: 600, color: c.enabled ? "#16a34a" : "#b45309" }}>{c.enabled ? "on" : "off"}</td>
                    <td style={{ opacity: 0.7 }}>{who(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" onClick={() => { try { sessionStorage.removeItem(TOKEN_KEY); } catch {} setToken(null); setRows(null); }}
            style={{ marginTop: 16, font: "inherit", fontSize: 12, background: "none", border: "none", textDecoration: "underline", cursor: "pointer", opacity: 0.7 }}>Sign out</button>
        </>
      )}
    </main>
  );
}
