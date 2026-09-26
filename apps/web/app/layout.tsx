import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "LiveCanvas", description: "Speak a design; watch it assemble." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
