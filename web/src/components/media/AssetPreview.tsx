"use client";

// Fullscreen preview for a media_asset. Rendering rules:
//   - image  → <img> centered, click backdrop to close
//   - video  → <video controls autoplay>
//   - audio  → <audio controls>
//   - pdf    → <iframe> renders inline (browsers support this)
//   - other  → filename card + Download button (browsers can't preview
//              office docs / zip inline anyway)
//
// Esc closes. Click backdrop closes. Focus is trapped on the close button.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import type { MediaAsset } from "@/lib/types";
import { fetchMediaBlobUrl } from "@/lib/api";
import { familyFromMime, humanBytes } from "./mediaShared";

export function AssetPreview({
  asset, onClose,
}: {
  asset: MediaAsset;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Resolve the URL the <iframe>/<img>/<a> actually loads.
  //
  // A raw browser tag can't send an Authorization header, so it must never
  // point at /media/proxy (that endpoint 401s "Missing bearer token" without a
  // bearer — the reason library previews were broken).
  //
  //  - user_upload  → blobUrl is a PUBLIC Vercel Blob URL: load it directly.
  //  - provider-hosted (Twilio / Exotel / Gmail) → the bytes live behind
  //    credentials only the server holds, so we fetch() them WITH auth and hand
  //    the tag a blob: object URL. Revoked on unmount.
  const [proxiedUrl, setProxiedUrl] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);

  useEffect(() => {
    if (!asset.providerHosted) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setProxiedUrl(null);
    setProxyError(null);
    fetchMediaBlobUrl(asset.id)
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        objectUrl = u;
        setProxiedUrl(u);
      })
      .catch((e: Error) => { if (!cancelled) setProxyError(e.message); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id, asset.providerHosted]);

  const url = useMemo(
    () => (asset.providerHosted ? proxiedUrl : asset.blobUrl),
    [asset.providerHosted, asset.blobUrl, proxiedUrl],
  );

  const fam = familyFromMime(asset.contentType);
  const canPreviewInline = fam === "image" || fam === "video" || fam === "audio" || asset.contentType === "application/pdf";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-2xl bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-rule px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-ink" title={asset.filename}>
              {asset.filename}
            </div>
            <div className="mono-cap text-[10.5px] tracking-[.04em] text-mute">
              {humanBytes(asset.sizeBytes)} · {asset.contentType}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={url ?? undefined}
              download={asset.filename}
              aria-disabled={!url}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet",
                !url && "pointer-events-none opacity-50",
              )}
              title="Download"
            >
              <Icon name="doc" size={12} strokeWidth={2.2} />
              Download
            </a>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-mute hover:bg-warm hover:text-ink"
              aria-label="Close"
              title="Close (Esc)"
            >
              <Icon name="plus" size={16} strokeWidth={2.2} className="rotate-45" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 items-center justify-center overflow-auto bg-warm/40 p-4">
          {proxyError ? (
            <div className="p-10 text-center text-[13px] text-state-warn">
              Couldn’t load this file: {proxyError}
            </div>
          ) : !url ? (
            <div className="p-10 text-center text-[13px] text-mute">Loading…</div>
          ) : (
          <>
          {fam === "image" && (
            <img
              src={url}
              alt={asset.filename}
              className="max-h-full max-w-full object-contain"
            />
          )}
          {fam === "video" && (
            <video
              controls
              autoPlay
              className="max-h-full max-w-full"
            >
              <source src={url} type={asset.contentType} />
            </video>
          )}
          {fam === "audio" && (
            <div className="w-full max-w-[600px] rounded-lg border border-rule bg-paper p-6">
              <div className="mb-3 flex justify-center">
                <Icon name="star" size={40} strokeWidth={1.5} className="text-mute" />
              </div>
              <audio controls className="w-full">
                <source src={url} type={asset.contentType} />
              </audio>
            </div>
          )}
          {asset.contentType === "application/pdf" && (
            <iframe
              src={url}
              title={asset.filename}
              className="h-[75vh] w-full rounded border border-rule bg-white"
            />
          )}
          {!canPreviewInline && (
            <NonPreviewable asset={asset} url={url} />
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}

function NonPreviewable({ asset, url }: { asset: MediaAsset; url: string }) {
  const fam = familyFromMime(asset.contentType);
  const label =
    fam === "document" ? "Office document"
    : fam === "archive"  ? "Archive"
    : "File";
  return (
    <div className="flex flex-col items-center gap-4 p-10 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-warm2/60 text-mute">
        <Icon name="doc" size={48} strokeWidth={1.4} />
      </div>
      <div>
        <div className="text-[15px] font-semibold text-ink">{label} — no in-browser preview</div>
        <div className="mt-1 max-w-md text-[12.5px] text-mute">
          Your browser can&apos;t render this format inline. Download to open in the appropriate app
          ({asset.contentType.split("/").pop()}).
        </div>
      </div>
      <a
        href={url}
        download={asset.filename}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-brand-violet bg-brand-violet px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-brand-violet/90",
        )}
      >
        <Icon name="doc" size={13} strokeWidth={2.2} />
        Download {asset.filename}
      </a>
    </div>
  );
}
