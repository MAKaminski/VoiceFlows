import { defaultFlags, type FeatureKey, type Flags } from "@livecanvas/dsl";
import type { Persistence } from "./persist.js";

/**
 * Feature flags (ADR 0012): cached in memory, loaded at boot, flipped by the admin API. Reads are a
 * property lookup — nothing on the hot path waits on the database. One gateway replica is assumed
 * (a flip reaches only this process); with more replicas, reload on a short TTL instead.
 */
export class FlagService {
  private flags: Flags = defaultFlags();
  private listeners = new Set<(f: Flags) => void>();
  constructor(private readonly persistence: Persistence, private readonly log: (m: string) => void = () => {}) {}

  async load() {
    try { Object.assign(this.flags, await this.persistence.loadFlags()); }
    catch (e) { this.log(`flags: load failed, using defaults (${(e as Error).message})`); }
  }
  all(): Flags { return { ...this.flags }; }
  on(key: FeatureKey): boolean { return this.flags[key]; }
  /** `change` records who flipped it in the flag history (ADR 0020). */
  async set(key: FeatureKey, enabled: boolean, change?: { source: "admin" | "seed"; actor?: string | null }) {
    await this.persistence.setFlag(key, enabled, change);
    this.flags[key] = enabled;
    this.log(`flags: ${key} → ${enabled ? "on" : "off"}`);
    for (const l of this.listeners) l(this.all());
  }
  subscribe(l: (f: Flags) => void) { this.listeners.add(l); return () => void this.listeners.delete(l); }
}
