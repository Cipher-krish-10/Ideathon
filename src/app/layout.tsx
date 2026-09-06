import Link from "next/link";
import type { Metadata, Viewport } from "next";

import { getSession } from "@/server/auth/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "RevenuePilot",
  description: "AI merchant growth agent for Razorpay — failed-payment recovery.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession().catch(() => null);

  return (
    <html lang="en">
      <body>
        {/* Always visible. There is no live-mode code path in this build. */}
        <div className="test-banner">
          <span>Razorpay Test Mode — no live money can move</span>
          <span>{session ? `${session.name} · ${session.role}` : "no demo user"}</span>
        </div>
        <nav className="nav">
          <span className="brand">RevenuePilot</span>
          <Link href="/">Command Centre</Link>
          <Link href="/opportunities">Opportunities</Link>
          <Link href="/interventions">Interventions</Link>
          <Link href="/policies">Policies</Link>
          <Link href="/audit">Audit</Link>
          <span className="spacer" />
          <span className="role">{session?.role ?? "—"}</span>
        </nav>
        {children}
      </body>
    </html>
  );
}
