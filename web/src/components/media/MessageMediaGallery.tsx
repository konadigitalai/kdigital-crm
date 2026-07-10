"use client";

// Renders a message's attached media inside a chat bubble.
//  - image → <img> thumbnail (click opens full-size in a new tab)
//  - video → <video controls> player
//  - audio → <audio controls>
//  - PDF/doc/zip/other → download link with filename + size
//
// URL choice: the server injects a short-lived signed `fetchUrl` per
// media item (see routes/twilio.ts). We use that so raw <img>/<video>/
// <a href> tags work without an Authorization header — browsers can't
// attach JWTs to media requests. If the server doesn't include a signed
// URL (env misconfig), we fall back to a filename-only card.

import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { TwMessageMedia } from "@/lib/types";
import { humanBytes, familyFromMime } from "./mediaShared";

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
  const url = media.fetchUrl;

  const fam = familyFromMime(media.contentType);
  const cellCls = cn(
    "rounded-lg overflow-hidden max-w-[280px]",
    outbound ? "bg-white/40 ring-1 ring-black/5" : "bg-white/70 ring-1 ring-rule",
  );

  // No signed URL from the server — degrade to a filename-only card so we
  // never render <img src="">, which would show a broken-image glyph.
  if (!url) {
    return (
      <div className={cn(
        cellCls,
        "flex items-center gap-2 px-3 py-2 text-[12.5px] opacity-70",
        outbound ? "text-ink" : "text-ink",
      )}>
        <Icon name="doc" size={16} strokeWidth={2} className="text-mute" />
        <div className="min-w-0">
          <div className="truncate font-semibold" title={media.filename}>{media.filename}</div>
          <div className="font-mono text-[9.5px] text-mute">
            {humanBytes(media.sizeBytes)} · {media.contentType.split("/").pop()} · preview unavailable
          </div>
        </div>
      </div>
    );
  }

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
        outbound ? "text-ink" : "text-ink",
      )}
    >
      <Icon name="doc" size={16} strokeWidth={2} className="text-mute" />
      <div className="min-w-0">
        <div className="truncate font-semibold" title={media.filename}>{media.filename}</div>
        <div className="font-mono text-[9.5px] text-mute">
          {humanBytes(media.sizeBytes)} · {media.contentType.split("/").pop()}
        </div>
      </div>
    </a>
  );
}
