import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { Sidebar } from "@/components/layout/sidebar";
import { getSession } from "@/server/auth/session";
import "./globals.css";

/**
 * Inter, self-hosted.
 *
 * Deliberately not `next/font/google`: that fetches at build time, so a build
 * on a machine without network — a demo laptop, an offline CI runner — would
 * fail on a typeface. The variable latin subset is 47KB and committed.
 */
const inter = localFont({
  src: "./fonts/inter-latin-var.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "RevenuePilot — Merchant Growth Agent",
  description: "Find lost revenue. Choose the best intervention. Act safely.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession().catch(() => null);

  return (
    <html lang="en" className={inter.variable}>
      <body>
        <div className="shell">
          <Sidebar
            merchantName="Nimbus Commerce"
            mode="TEST"
            role={session?.role ?? "VIEWER"}
            userName={session?.name ?? "Demo user"}
          />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
