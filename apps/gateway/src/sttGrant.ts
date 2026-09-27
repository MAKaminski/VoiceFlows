import type { SttGrant } from "@livecanvas/dsl";
import type { Config } from "./config.js";

export const FLUX_BROWSER_URL = "wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000";

/**
 * Chooses how a browser gets speech-to-text (ADR 0008): direct (short-lived Deepgram JWT) when
 * the configured key may mint grants, relay through the gateway when it may not, Web Speech when
 * there is no key. A 401/403 from the grant endpoint is remembered so we stop asking.
 */
export function createSttGrant(cfg: Pick<Config, "DEEPGRAM_API_KEY" | "STT_DIRECT">, fetchImpl: typeof fetch = fetch) {
  let directAllowed: boolean | undefined;
  return async function grant(): Promise<SttGrant> {
    if (!cfg.DEEPGRAM_API_KEY) return { mode: "webspeech" };
    if (cfg.STT_DIRECT && directAllowed !== false) {
      const res = await fetchImpl("https://api.deepgram.com/v1/auth/grant", {
        method: "POST",
        headers: { authorization: `Token ${cfg.DEEPGRAM_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl_seconds: 60 }),
      });
      if (res.ok) {
        directAllowed = true;
        const j = (await res.json()) as { access_token: string; expires_in: number };
        return { mode: "direct", provider: "deepgram-flux", url: FLUX_BROWSER_URL, token: j.access_token, expiresIn: j.expires_in };
      }
      if (res.status === 401 || res.status === 403) directAllowed = false;
    }
    return { mode: "relay", provider: "deepgram-flux" };
  };
}
