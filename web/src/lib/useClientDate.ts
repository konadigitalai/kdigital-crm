"use client";

// Hook for formatting dates in client components without hydration
// mismatches.
//
// The problem: server-side rendering and client rendering can use
// different default locales (Node defaults to en-US, the browser uses
// whatever the user has set — en-IN here). `toLocaleString()` formats
// "2026-06-17" as "6/17/2026" on the server and "17/6/2026" on the
// client → React detects the divergence and complains.
//
// The fix: render an empty placeholder during SSR, then swap to the
// formatted value once mounted. SSR HTML is deterministic; the post-
// hydration update happens only on the client where there's nothing
// to compare against.

import { useEffect, useState } from "react";

/** Returns true after the component has mounted on the client. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted;
}

const DEFAULT_LOCALE = "en-IN";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(DEFAULT_LOCALE);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(DEFAULT_LOCALE);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(DEFAULT_LOCALE);
}
