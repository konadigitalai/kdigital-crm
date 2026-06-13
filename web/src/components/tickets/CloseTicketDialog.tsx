"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { closeTicket } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { CatalogResponse, TicketResolutionCode } from "@/lib/types";

const FALLBACK_CODES: { key: TicketResolutionCode; label: string }[] = [
  { key: "fixed",     label: "Fixed" },
  { key: "duplicate", label: "Duplicate" },
  { key: "wont_fix",  label: "Won't fix" },
  { key: "no_action", label: "No action needed" },
];

export function CloseTicketDialog({
  number,
  catalog,
  onClose,
}: {
  number: string;
  catalog: CatalogResponse | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const codes = catalog?.resolutionCodes?.length ? catalog.resolutionCodes : FALLBACK_CODES;

  const [resolution, setResolution] = useState("");
  const [resolutionCode, setResolutionCode] = useState<TicketResolutionCode>("fixed");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!resolution.trim()) return setError("Resolution is required to close a ticket.");
    setSubmitting(true);
    try {
      await closeTicket(number, { resolution: resolution.trim(), resolutionCode });
      router.refresh();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const trimmed = resolution.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < 8;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">Close ticket {number}</h2>
            <p className="mt-1 text-[12.5px] text-mute">
              You must record a resolution. It becomes part of the ticket's permanent history.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
              Resolution <span className="ml-1 text-brand-magenta">*</span>
            </span>
            <textarea
              autoFocus
              required
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              className={cn(
                "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20",
                "min-h-[140px] resize-y",
              )}
              placeholder="What was done? What did the user end up with? Be specific — future you will thank past you."
            />
            {tooShort && (
              <span className="mt-1 block text-[11px] text-state-amber">A real resolution is usually more than a few words.</span>
            )}
          </label>

          <label className="block">
            <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">Resolution code</span>
            <select
              value={resolutionCode}
              onChange={(e) => setResolutionCode(e.target.value as TicketResolutionCode)}
              className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
            >
              {codes.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button
              type="submit"
              disabled={submitting || !resolution.trim()}
              className="btn-grad disabled:opacity-50"
            >
              {submitting ? "Closing…" : "Close ticket"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
