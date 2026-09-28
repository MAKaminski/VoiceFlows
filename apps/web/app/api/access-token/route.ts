import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, mint, verify } from "@/lib/token";

/** A 10-minute gateway token for someone holding the access cookie (ADR 0021). 204 = the gate is off. */
export async function GET(req: NextRequest) {
  const secret = process.env.ACCESS_SECRET;
  if (!secret) return new NextResponse(null, { status: 204 });
  if (!(await verify(secret, req.cookies.get(COOKIE)?.value, ["cookie"]))) return NextResponse.json({ error: "no access" }, { status: 401 });
  return NextResponse.json(await mint(secret, "full", 10 * 60_000), { headers: { "cache-control": "no-store" } });
}
