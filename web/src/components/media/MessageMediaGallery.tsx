"use client";

// Renders a message's attached media inside a chat bubble.
//  - image → <img> thumbnail (click opens full-size in a new tab)
//  - video → <video controls> player
//  - audio → <audio controls>
//  - PDF/doc/zip/other → download link with filename + size
// Twilio-hosted URLs (providerHosted=true) route through /media/proxy/:id
// so the Basic-auth exchange happens server-side.

import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { TwMessageMedia } from "@/lib/types";
import { humanBytes, familyFromMime } from "./mediaShared";

// The API URL — same rule as web/src/lib/api.ts.
const API_URL = (() => {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  }
  return process.env.NODE_ENV === "production"
    ? "/api"
    : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000");
})();

export function MessageMediaGallery({
  media, outbound, className,
}: {
  media: TwMessageMedia[];
  outbound: boolean;
  className?: string;
}) {
  if (!media || media.length === 0) return null;
  return (
    <div className={cn("mt-2 flex flex-col gap-1.5", className)}>
      {media.map((m) => <Item key={m.assetId} media={m} outbound={outbound} />)}
    </div>
  );
}

function Item({ media, outbound }: { media: TwMessageMedia; outbound: boolean }) {
  // provider-hosted URLs go through our authenticated proxy; our own Blob
  // URLs are already public HTTPS so we can hit them direct.
  const url = media.providerHosted
    ? `${API_URL}/media/proxy/${encodeURIComponent(media.assetId)}`
    : `${API_URL}/media/proxy/${encodeURIComponent(media.assetId)}`;
  // (Always through proxy — keeps auth check consistent and browsers won't
  // leak the Blob URL to logs.)

  const fam = familyFromMime(media.contentType);
  const cellCls = cn(
    "rounded-lg overflow-hidden max-w-[280px]",
    outbound ? "bg-brand-violet/20 ring-1 ring-white/20" : "bg-white/70 ring-1 ring-rule",
  );

  if (fam === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className={cn(cellCls, "block")}>
        <img src={url} alt={media.filename} className="max-h-[260px] w-full object-cover" loading="lazy" />
      </a>
    );
  }
  if (fam === "video") {
    return (
      <div className={cellCls}>
        <video controls preload="metadata" className="max-h-[260px] w-full">
          <source src={url} type={media.contentType} />
        </video>
      </div>
    );
  }
  if (fam === "audio") {
    return (
      <div className={cn(cellCls, "px-2.5 py-2")}>
        <audio controls preload="metadata" className="w-full">
          <source src={url} type={media.contentType} />
        </audio>
      </div>
    );
  }
  // Documents, archives, other — download link.
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      download={media.filename}
      className={cn(
        cellCls,
        "flex items-center gap-2 px-3 py-2 text-[12.5px]",
        outbound ? "text-white" : "text-ink",
      )}
    >
      <Icon name="doc" size={16} strokeWidth={2} className={outbound ? "text-white" : "text-mute"} />
      <div className="min-w-0">
        <div className="truncate font-semibold" title={media.filename}>{media.filename}</div>
        <div className={cn("font-mono text-[9.5px]", outbound ? "text-white/70" : "text-mute")}>
          {humanBytes(media.sizeBytes)} · {media.contentType.split("/").pop()}
        </div>
      </div>
    </a>
  );
}
