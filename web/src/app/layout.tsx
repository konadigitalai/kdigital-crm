import type { Metadata } from "next";
import { Inter_Tight, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Auth0Provider } from "@auth0/nextjs-auth0";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kona OS - Edify",
  description: "Digital Edify Agentic CRM",
};

// Execute in Mumbai, not Vercel's us-east-1 default.
//
// Our users and our data are both in India: the browser is in-country and
// Azure Postgres sits in Central India. Left unpinned, every Server Component
// fetch and every /api/* rewrite hop ran out of Washington DC — roughly half a
// second of pure network per request, crossing the Pacific twice. Pinning to
// bom1 deletes both of those legs.
//
// vercel.json sets this project-wide too; this is the belt for the suspenders,
// since a route segment can otherwise silently opt itself elsewhere.
export const preferredRegion = ["bom1"];

// The design system is drawn in these three faces — Inter Tight for body,
// Instrument Serif for display headings, JetBrains Mono for the uppercase
// labels (.mono-cap: ADVISOR, RATING, TODAY · 12 JUL, LEAD-####). They were
// dropped when Next 15 rejected the old CSS @import, which left the whole app
// falling back to the system stack and looking heavier than the mockups.
// next/font/google self-hosts the files (no runtime request, no @import), and
// exposes each as a CSS variable that tailwind.config + globals.css consume.
const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-serif",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Auth0Provider exposes useUser()/getAccessToken() to every client
  // component below. It does NOT do auth itself — the SDK middleware
  // (web/src/middleware.ts) handles routing, cookies, and refresh.
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body className="bg-canvas font-sans text-ink antialiased">
        <Auth0Provider>{children}</Auth0Provider>
      </body>
    </html>
  );
}
