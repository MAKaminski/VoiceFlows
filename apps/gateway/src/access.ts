import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Access tokens (ADR 0021) — the same format the web mints with Web Crypto (apps/web/lib/token.ts):
 * `purpose.expiryMs.hmac`, HMAC-SHA256 over `purpose.expiryMs`, base64url. The purpose is signed, so a 30-day
 * `cookie` value is never accepted where a 10-minute `full` or `demo` token is required.
 */
export type Purpose = "cookie" | "full" | "demo";
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function mintAccess(secret: string, purpose: Purpose, ttlMs: number): string {
  const body = `${purpose}.${Date.now() + ttlMs}`;
  return `${body}.${sign(secret, body)}`;
}

export function verifyAccess(secret: string, token: string | undefined, purposes: Purpose[]): Purpose | null {
  const [purpose, exp, sig] = (token ?? "").split(".");
  if (!purpose || !exp || !sig || !purposes.includes(purpose as Purpose) || !(Number(exp) > Date.now())) return null;
  const want = Buffer.from(sign(secret, `${purpose}.${exp}`)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? (purpose as Purpose) : null;
}
