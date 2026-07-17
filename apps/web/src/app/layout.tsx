import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegister } from "./service-worker-register";
import { AuthProvider } from "@/lib/auth-context";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Required by the nonce-based CSP in proxy.ts: nonces are injected during
// server rendering, so a statically prerendered page would ship without one
// and have its own scripts blocked. Every route is therefore dynamic. This is
// a deliberate trade of static prerendering for a CSP with no 'unsafe-inline'.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "OraOS",
  description: "AI Restaurant Operating System",
  appleWebApp: { capable: true, title: "OraOS", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#facc15",
  width: "device-width",
  initialScale: 1,
  // Zoom deliberately left enabled — disabling it fails WCAG 1.4.4.
  // Double-tap zoom is handled with touch-action in globals.css instead.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ServiceWorkerRegister />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
