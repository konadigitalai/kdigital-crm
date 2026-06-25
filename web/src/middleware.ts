// Next.js middleware — delegated to @auth0/nextjs-auth0.
//
// The SDK's middleware does two things for us:
//   1. Auto-mounts the auth routes (/auth/login, /auth/logout, /auth/callback,
//      /auth/profile, /auth/access-token) so we never write our own.
//   2. Manages the encrypted session cookie + refresh-token rotation so
//      Server Components and Route Handlers can pull the user via
//      auth0.getSession() without thinking about token lifetimes.
//
// We add one extra concern on top: redirect unauthenticated browser
// navigations to /auth/login. The SDK does NOT enforce this — it just
// makes the routes available. We have to gate the rest of the app
// ourselves.

import { NextResponse, type NextRequest } from "next/server";
import { auth0 } from "@/lib/auth0";

export async function middleware(req: NextRequest) {
  // Let the SDK handle its own routes first.
  const authResp = await auth0.middleware(req);

  // The auth routes themselves should not be gated — return the SDK's
  // response (which may be a redirect to Auth0, a cookie set, etc.).
  if (req.nextUrl.pathname.startsWith("/auth/")) {
    return authResp;
  }

  // /login is our pre-Auth0 entry point. Keep it accessible so we can
  // show a "Sign in with Auth0" landing card before the redirect.
  if (req.nextUrl.pathname === "/login") {
    return authResp;
  }

  // Static + Next internals + favicon are exempt — matcher below already
  // filters most of them; this is the belt for the suspenders.
  if (
    req.nextUrl.pathname.startsWith("/_next") ||
    req.nextUrl.pathname === "/favicon.ico"
  ) {
    return authResp;
  }

  // Anything else requires an authenticated session.
  const session = await auth0.getSession(req);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/auth/login";
    // Bounce back to where the user was trying to go after login.
    url.searchParams.set("returnTo", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // Authenticated — pass through with whatever cookie updates the SDK
  // baked into the response (refresh-token rotation, etc.).
  return authResp;
}

export const config = {
  // Match everything except Next internals + obvious static files. The
  // SDK middleware filters further internally.
  matcher: ["/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
