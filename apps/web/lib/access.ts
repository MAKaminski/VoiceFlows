"use client";
/**
 * Gateway access tokens in the browser (ADR 0021): fetched from our own API routes (the secret never reaches the
 * browser), cached until a minute before expiry, refreshed on a 401. `undefined` = the gate is off.
 */
type Scope = "full" | "demo";
const cache: Partial<Record<Scope, { token: string; exp: number }>> = {};

export async function getAccess(scope: Scope = "full", fresh = false): Promise<string | undefined> {
  const c = cache[scope];
  if (!fresh && c && c.exp - 60_000 > Date.now()) return c.token;
  const r = await fetch(scope === "demo" ? "/api/demo-token" : "/api/access-token", { cache: "no-store" });
  if (r.status === 204) return undefined;
  if (r.status === 401) { location.assign(`/?next=${encodeURIComponent(location.pathname)}`); throw new Error("no access"); }
  if (!r.ok) throw new Error(`access token: HTTP ${r.status}`);
  const d = (await r.json()) as { token: string; exp: number };
  cache[scope] = d;
  return d.token;
}

/** fetch() to the gateway with the access token; one retry with a fresh token on 401. */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const go = async (fresh: boolean) => {
    const t = await getAccess("full", fresh).catch(() => undefined);
    return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(t ? { authorization: `Bearer ${t}` } : {}) } });
  };
  const res = await go(false);
  return res.status === 401 ? go(true) : res;
}
