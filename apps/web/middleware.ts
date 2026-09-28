import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verify } from "./lib/token";

/**
 * Invite gate (ADR 0021): the product needs the access cookie set by /api/enter. The home page, the demo, share
 * links and static files stay public. With no ACCESS_SECRET (local dev) everything is open.
 */
export const config = { matcher: ["/studio/:path*", "/playground/:path*", "/p/:path*", "/admin/:path*"] };

export async function middleware(req: NextRequest) {
  const secret = process.env.ACCESS_SECRET;
  if (!secret) return NextResponse.next();
  if (await verify(secret, req.cookies.get(COOKIE)?.value, ["cookie"])) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}
