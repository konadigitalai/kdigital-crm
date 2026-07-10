"use client";

// Horizontal strip of "staged attachments" shown in the send modal + inbox
// reply box. Each chip has a filename + type + a remove button.

import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { MediaAsset } from "@/lib/types";
import { humanBytes, familyFromMime } from "./mediaShared";

export function StagedStrip({
  assets, onRemove, className,
}: {
  assets: MediaAsset[];
  onRemove: (assetId: string) => void;
  className?: string;
}) {
  if (assets.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {assets.map((a) => (
        <div
          key={a.id}
          className="flex max-w-[220px] items-center gap-2 rounded-full border border-rule bg-warm/40 px-2.5 py-1 text-[12px]"
        >
          {familyFromMime(a.contentType) === "image" ? (
            <img src={a.blobUrl} alt="" className="h-5 w-5 flex-shrink-0 rounded object-cover" />
          ) : (
            <Icon name="doc" size={12} strokeWidth={2} className="flex-shrink-0 text-mute" />
          )}
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink" title={a.filename}>{a.filename}</div>
            <div className="mono-cap text-[9px] tracking-[.04em] text-mute">{humanBytes(a.sizeBytes)}</div>
          </div>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="ml-1 flex-shrink-0 text-mute hover:text-state-warn"
            aria-label="Remove attachment"
          >
            <Icon name="plus" size={12} strokeWidth={2.4} className="rotate-45" />
          </button>
        </div>
      ))}
    </div>
  );
}
