import type { Metadata } from "next";
import type { ReactNode } from "react";

// Shared views are unlisted: never indexed, and the token never leaves in a Referer header (ADR 0013).
export const metadata: Metadata = { title: "LiveCanvas · shared", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function SharedLayout({ children }: { children: ReactNode }) { return children; }
