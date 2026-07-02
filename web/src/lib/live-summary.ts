// Live-summary bridge.
//
// The sidebar / IconRail render server-side with the summary that AppShell
// fetched at page load. That number goes stale the moment the user creates
// a lead, closes a case, deletes something, etc.
//
// This module offers two pieces:
//
//   emitCrmMutation()       — call this after ANY mutation that could change
//                             a badge (create lead, delete lead, close case,
//                             etc.). It's a fire-and-forget custom event.
//
//   useLiveSummary(initial) — a hook the sidebar uses. Starts with the SSR
//                             value, then swaps to fresh data whenever a
//                             mutation event fires OR the route changes.

"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getSummary } from "./api";
import type { SummaryResponse } from "./types";

export const CRM_MUTATION_EVENT = "crm:mutation";

/** Fire-and-forget. Called by any client component after a successful mutation. */
export function emitCrmMutation(kind?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CRM_MUTATION_EVENT, { detail: { kind } }));
}

/**
 * Subscribes to mutation events + pathname changes and returns the freshest
 * summary. Falls back to the initial (server-fetched) value while a refetch
 * is in flight.
 */
export function useLiveSummary(initial: SummaryResponse): SummaryResponse {
  const [summary, setSummary] = useState<SummaryResponse>(initial);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const fresh = await getSummary();
        if (!cancelled) setSummary(fresh);
      } catch {
        // Silent — badges just keep the last known number if the refetch fails.
      }
    }

    // Refresh on any mutation event.
    const onMutation = () => { void refresh(); };
    window.addEventListener(CRM_MUTATION_EVENT, onMutation);

    // Also refresh whenever we navigate (covers cases where a mutation
    // triggered router.push and the user landed on a different page).
    void refresh();

    return () => {
      cancelled = true;
      window.removeEventListener(CRM_MUTATION_EVENT, onMutation);
    };
    // pathname dep: rerun the refresh when the user navigates.
  }, [pathname]);

  return summary;
}
