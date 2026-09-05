import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "RevenuePilot",
  description: "AI merchant growth agent for Razorpay — failed-payment recovery.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
