import type { Metadata, Viewport } from "next";

import { Sidebar } from "@/components/layout/sidebar";
import { getSession } from "@/server/auth/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "RevenuePilot — Merchant Growth Agent",
  description: "Find lost revenue. Choose the best intervention. Act safely.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession().catch(() => null);

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar
            merchantName="Nimbus Commerce"
            mode="TEST"
            role={session?.role ?? "VIEWER"}
          />
          <div className="main">{children}</div>
        </div>
      </body>
    </html>
  );
}
