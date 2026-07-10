import type { Metadata } from "next";
import { Auth0Provider } from "@auth0/nextjs-auth0";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kona OS - Edify",
  description: "Digital Edify Agentic CRM",
};

// Google Fonts loaded via <link> instead of @import in globals.css.
// Next.js 15's CSS loader tries to statically resolve @import URLs at
// build time and fails on remote stylesheets — @link is HTML-only and
// bypasses the bundler entirely.
const FONTS_HREF =
  "https://fonts.googleapis.com/css2" +
  "?family=Inter+Tight:wght@400;500;600;700" +
  "&family=Instrument+Serif:ital@0;1" +
  "&family=JetBrains+Mono:wght@500;600;700" +
  "&display=swap";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Auth0Provider exposes useUser()/getAccessToken() to every client
  // component below. It does NOT do auth itself — the SDK middleware
  // (web/src/middleware.ts) handles routing, cookies, and refresh.
  return (
    <html lang="en">
      <head>
        {/* preconnect shaves ~100ms off first font paint */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS_HREF} />
      </head>
      <body className="bg-canvas font-sans text-ink antialiased">
        <Auth0Provider>{children}</Auth0Provider>
      </body>
    </html>
  );
}
