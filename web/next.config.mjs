import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Pin the workspace root to THIS directory. Next.js's "detect the root by
// walking up until a lockfile is found" heuristic misfires when a stray
// package-lock.json exists in a parent (e.g. C:\Users\<name>\). The wrong
// root produces a wrong module resolver, which then dies compiling
// globals.css with a misleading "Can't resolve './...'" error.
const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: __dirname,

  // Browser-side requests go to /api/* on the same Vercel origin and Next.js
  // forwards them to the actual Express API on Render. This sidesteps the
  // third-party-cookie problem cross-origin auth has on modern Chrome —
  // from the browser's POV everything is first-party to the Vercel domain.
  //
  // Server Components keep calling API_URL directly (server-side, no
  // browser cookies / CORS / SameSite to worry about there).
  async rewrites() {
    const target = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
    if (!target) {
      // Local dev usually doesn't set API_URL; fall through and the source
      // code default of http://localhost:4000 will be used by client fetches.
      return [];
    }
    return [
      { source: "/api/:path*", destination: `${target}/:path*` },
    ];
  },
};

export default nextConfig;
