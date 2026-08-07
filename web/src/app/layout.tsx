import type { Metadata } from "next";
import { Inter_Tight, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import { Auth0Provider } from "@auth0/nextjs-auth0";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kona OS - Edify",
  description: "Digital Edify Agentic CRM",
};

// Execute next to the DATABASE, not next to the users.
//
// This was pinned to bom1 (Mumbai) on the belief that Azure Postgres sat in
// Central India. It does not — `de-crm-pg` is in **Canada Central**, which is
// why a warm pooled `SELECT now()` measured ~230ms while the server executed
// it in 0.1ms. The app is latency-bound, and withTenant makes three round
// trips per operation, so that mistake cost ~690ms on every tenant-scoped
// query.
//
// Users therefore pay one longer hop to Cleveland instead of 230ms multiplied
// by every round trip, which is several times faster overall.
//
// The right end state is the database in Central India and this back on bom1:
// ~110ms to Vercel AND ~5ms to Postgres. Until that migration happens, compute
// belongs beside the data.
//
// MUST match `regions` in vercel.json. If they disagree, Server Components
// render in one region and the /api handlers run in another, so every
// in-app fetch crosses continents.
export const preferredRegion = ["cle1"];

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
