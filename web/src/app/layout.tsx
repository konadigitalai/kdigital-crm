import type { Metadata } from "next";
import { Auth0Provider } from "@auth0/nextjs-auth0";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kona OS - Edify",
  description: "Digital Edify Agentic CRM",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Auth0Provider exposes useUser()/getAccessToken() to every client
  // component below. It does NOT do auth itself — the SDK middleware
  // (web/src/middleware.ts) handles routing, cookies, and refresh.
  //
  // Custom Google Fonts (Inter Tight, Instrument Serif, JetBrains Mono)
  // were previously loaded here, but were removed after Next.js 15's CSS
  // loader started rejecting the CSS @import. The app falls back to the
  // system stack declared in globals.css. If you want the custom fonts
  // back, prefer next/font/google over CSS @import or <link>.
  return (
    <html lang="en">
      <body className="bg-canvas font-sans text-ink antialiased">
        <Auth0Provider>{children}</Auth0Provider>
      </body>
    </html>
  );
}
