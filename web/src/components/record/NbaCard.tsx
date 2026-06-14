"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import { refreshNba } from "@/lib/api";

const VALID_NBA_ICONS: ReadonlyArray<IconName> = [
  "send", "clock", "mail", "star", "check", "info", "money",
];

function isNbaIcon(s: string | null | undefined): s is IconName {
  return !!s && (VALID_NBA_ICONS as readonly string[]).includes(s);
}

interface NbaCardProps {
  leadNumber: string;
  fallbackLabel: string;
  fallbackReason: string | null;
  nbaCard: { confidence: number | null; headline: string; why: string } | null;
  nbaIcon: string | null;
  /** When false, the "Refresh suggestion" button is hidden. */
  canRefresh?: boolean;
}

export function NbaCard({
  leadNumber,
  fallbackLabel,
  fallbackReason,
  nbaCard,
  nbaIcon,
  canRefresh = true,
}: NbaCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headline = nbaCard?.headline ?? `Recommended action: ${fallbackLabel}`;
  const why = nbaCard?.why ?? fallbackReason ?? "No suggestion yet — click Refresh to generate one.";
  const confidence = nbaCard?.confidence ?? null;
  const icon: IconName = isNbaIcon(nbaIcon) ? nbaIcon : "star";

  async function onRefresh() {
    setBusy(true);
    setError(null);
    try {
      await refreshNba(leadNumber);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nba-aurora relative mb-[22px] overflow-hidden rounded-[18px] bg-ink p-[22px] text-white">
      <div className="relative z-[1] mb-3.5 flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-grad">
          <Icon name={icon} size={15} strokeWidth={1.9} className="text-white" />
        </span>
        <span className="mono-cap text-[10px] font-semibold tracking-[.14em] text-white/60">
          Next best action · Edify Agent
        </span>
        {confidence !== null && (
          <span className="mono-cap ml-auto font-mono text-[10px] tracking-[.08em] text-[#B7F35A]">
            {confidence}% confidence
          </span>
        )}
      </div>

      <div className="relative z-[1] mb-2 font-serif text-[23px] leading-[1.25] text-white">
        {headline}
      </div>
      <div className="relative z-[1] mb-[18px] text-[13px] leading-[1.5] text-white/70">
        {why}
      </div>

      {error && (
        <div className="relative z-[1] mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      <div className="relative z-[1] flex flex-wrap gap-2.5">
        {canRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-full border-0 bg-white px-4 py-2.5 text-[12.5px] font-semibold text-ink disabled:opacity-60"
          >
            {busy ? (
              <>
                <Spinner /> Thinking…
              </>
            ) : (
              <>
                <Icon name="star" size={13} strokeWidth={2} />
                Refresh suggestion
              </>
            )}
          </button>
        )}
        <span className="self-center text-[11px] text-white/50">
          Generated from this lead's full timeline, payment trail, notes, and rating.
        </span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
