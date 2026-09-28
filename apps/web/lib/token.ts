/**
 * Signed access tokens (ADR 0021), Web Crypto only — so the same code runs in Next middleware (Edge) and route
 * handlers. Format `purpose.expiryMs.hmac` (HMAC-SHA256 over `purpose.expiryMs`, base64url). The purpose is part
 * of what is signed, so a 30-day `cookie` value can never be used as a gateway `full` or `demo` token.
 * The gateway verifies the same format with node:crypto (apps/gateway/src/access.ts).
 */
export type Purpose = "cookie" | "full" | "demo";
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}
export async function mint(secret: string, purpose: Purpose, ttlMs: number) {
  const exp = Date.now() + ttlMs;
  const body = `${purpose}.${exp}`;
  return { token: `${body}.${await sign(secret, body)}`, exp };
}
/** Constant-time string compare (both are base64url of a fixed-length HMAC). */
export function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function verify(secret: string, token: string | undefined, purposes: Purpose[]): Promise<Purpose | null> {
  const [purpose, exp, sig] = (token ?? "").split(".");
  if (!purpose || !exp || !sig || !purposes.includes(purpose as Purpose) || !(Number(exp) > Date.now())) return null;
  return same(sig, await sign(secret, `${purpose}.${exp}`)) ? (purpose as Purpose) : null;
}
export const COOKIE = "lc_access";
