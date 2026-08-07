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

  // `next dev` and `next build` both own .next, and on Windows the dev
  // server's file locks make a concurrent build hang rather than fail — it
  // sits there producing nothing until someone kills it. Setting
  // NEXT_DIST_DIR gives a build its own output directory so it can run while
  // the dev server stays up. Unset (the normal case, and every deployment)
  // it is exactly the default.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // The `/api/:path*` rewrite that used to proxy to the Express API on Render
  // is gone: those handlers are now served by src/app/api/[...path]/route.ts
  // on this origin, so there is nothing to forward to.
  //
  // What remains is a compatibility rewrite for the two provider webhooks.
  // Twilio and Exotel have `/webhooks/...` URLs configured in their consoles,
  // and those are registered against a live phone number — changing them is a
  // coordinated cutover, not a deploy. Mapping them onto the API mount keeps
  // the existing URLs working, so the switchover is one-way and reversible.
  async rewrites() {
    return [
      { source: "/webhooks/:path*", destination: "/api/webhooks/:path*" },
    ];
  },

  // pg ships optional native bindings it only uses if present. Webpack tries
  // to resolve them at build time and fails; this tells Next to require them
  // at runtime instead, which is what the Node runtime does anyway.
  serverExternalPackages: ["pg", "@langchain/langgraph-checkpoint-postgres"],
};

export default nextConfig;
