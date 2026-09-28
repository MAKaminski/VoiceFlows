import { NextResponse } from "next/server";
import { mint } from "@/lib/token";

/**
 * A 10-minute DEMO token for anyone (ADR 0021). Demo scope is enforced by the gateway: a fresh throwaway project,
 * no typed prompts, save, share or tune, a per-session call budget, and per-IP / daily caps.
 */
export async function GET() {
  const secret = process.env.ACCESS_SECRET;
  if (!secret) return new NextResponse(null, { status: 204 });
  return NextResponse.json(await mint(secret, "demo", 10 * 60_000), { headers: { "cache-control": "no-store" } });
}
