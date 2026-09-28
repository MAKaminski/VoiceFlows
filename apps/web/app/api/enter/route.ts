import { NextResponse } from "next/server";
import { COOKIE, mint, same } from "@/lib/token";

/**
 * Invite code → 30-day access cookie (ADR 0021). The code is high-entropy (three words + digits), so guessing
 * over HTTP is impractical; the per-IP limit here is best-effort (serverless instances don't share memory).
 */
const tries = new Map<string, { n: number; since: number }>();
const digest = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toLowerCase())))).map((b) => b.toString(16).padStart(2, "0")).join("");

export async function POST(req: Request) {
  const code = process.env.INVITE_CODE, secret = process.env.ACCESS_SECRET;
  if (!code || !secret) return NextResponse.json({ ok: true, open: true }); // gate not configured
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  const t = tries.get(ip);
  if (t && Date.now() - t.since < 10 * 60_000 && t.n >= 10) return NextResponse.json({ ok: false, error: "Too many tries — wait a few minutes" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const ok = typeof body.code === "string" && same(await digest(body.code), await digest(code));
  if (!ok) {
    tries.set(ip, t && Date.now() - t.since < 10 * 60_000 ? { n: t.n + 1, since: t.since } : { n: 1, since: Date.now() });
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ ok: false, error: "That code isn't right" }, { status: 401 });
  }
  const { token } = await mint(secret, "cookie", 30 * 24 * 3600_000);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });
  return res;
}
