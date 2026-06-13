// Next middleware — redirect unauthenticated browser navigations to /login.
// Only inspects the cookie (presence, not validity); the API still re-checks
// every request via authMiddleware. This is purely a UX shortcut to avoid
// rendering the AppShell shell on a doomed request.

import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "decrm_session";

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Allow login page itself, Next internals, public assets, and the favicon.
  if (
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/")
  ) {
    return NextResponse.next();
  }

  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Match everything except next internals + static files. Next 15 supports
  // the negative lookahead syntax in matcher entries.
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
