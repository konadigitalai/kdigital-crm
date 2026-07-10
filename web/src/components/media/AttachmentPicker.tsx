"use client";

// Attach-file dialog shown from the send modal + inbox reply box.
// Two tabs: "From library" (folder picker + asset grid) and "Upload new"
// (drag-drop + click-to-pick). Selecting or uploading a file passes it
// back to the caller via onSelected.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  listMediaFolders, listMediaAssets, uploadMediaAsset,
} from "@/lib/api";
import type { MediaAsset, MediaFolder, TwChannel } from "@/lib/types";
import { humanBytes, validateMediaForChannel, familyFromMime } from "./mediaShared";

type Tab = "library" | "upload";

export function AttachmentPicker({
  channel, canUpload, canAddToLibrary, onSelected, onClose,
}: {
  channel: TwChannel;
  /** Gate the upload tab on messaging.send + media.upload. */
  canUpload: boolean;
  /** Extra flag: allow toggling isLibrary=true during upload. */
  canAddToLibrary: boolean;
  onSelected: (asset: MediaAsset) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("library");
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-10 w-full max-w-[720px] rounded-2xl border border-rule bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-5 py-3">
          <h2 className="font-serif text-[19px] font-normal tracking-[-.01em]">Attach file</h2>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <div className="flex gap-1 border-b border-rule px-3 pt-2">
          <TabBtn active={tab === "library"} onClick={() => setTab("library")}>From library</TabBtn>
          {canUpload && (
            <TabBtn active={tab === "upload"} onClick={() => setTab("upload")}>Upload new</TabBtn>
          )}
        </div>

        <div className="p-5">
          {tab === "library" ? (
            <LibraryPane channel={channel} onSelected={onSelected} />
          ) : (
            <UploadPane channel={channel} canAddToLibrary={canAddToLibrary} onSelected={onSelected} />
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold transition",
        active ? "border-brand-violet text-ink" : "border-transparent text-mute hover:text-ink2",
      )}
    >
      {children}
    </button>
  );
}

// ── Library tab ──────────────────────────────────────────────────────────

function LibraryPane({
  channel, onSelected,
}: {
  channel: TwChannel;
  onSelected: (asset: MediaAsset) => void;
}) {
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const fs = await listMediaFolders();
        setFolders(fs);
        setLoading(false);
      } catch (err) { setError((err as Error).message); }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const rows = await listMediaAssets({
          scope: "library",
          folderId: activeFolder ?? undefined,
        });
        setAssets(rows);
      } catch (err) { setError((err as Error).message); }
    })();
  }, [activeFolder]);

  if (loading) return <div className="p-6 text-center text-[12.5px] text-mute">Loading…</div>;
  if (error)   return <div className="rounded-md border border-state-warn/40 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">{error}</div>;

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4">
      <div className="rounded-[10px] border border-rule bg-warm/30 p-2 text-[12.5px]">
        <FolderBtn active={activeFolder === null} onClick={() => setActiveFolder(null)}>All folders</FolderBtn>
        {folders.map((f) => (
          <FolderBtn key={f.id} active={activeFolder === f.id} onClick={() => setActiveFolder(f.id)}>
            {f.name} <span className="ml-auto font-mono text-[10px] text-mute">{f.assetCount}</span>
          </FolderBtn>
        ))}
      </div>
      <div>
        {assets.length === 0 ? (
          <div className="rounded-md border border-dashed border-rule2 p-8 text-center text-[12.5px] text-mute">
            No library files here yet. Upload something new using the tab above.
          </div>
        ) : (
          <div className="grid max-h-[400px] grid-cols-2 gap-2 overflow-y-auto pr-1">
            {assets.map((a) => {
              const check = validateMediaForChannel(channel, a.contentType, a.sizeBytes);
              return (
                <AssetTile
                  key={a.id}
                  asset={a}
                  disabled={!check.ok}
                  disabledReason={check.ok ? "" : check.reason}
                  onClick={() => check.ok && onSelected(a)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FolderBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-medium transition",
        active ? "bg-brand-violet text-white" : "text-ink2 hover:bg-paper",
      )}
    >
      {children}
    </button>
  );
}

function AssetTile({
  asset, disabled, disabledReason, onClick,
}: {
  asset: MediaAsset;
  disabled: boolean;
  disabledReason: string;
  onClick: () => void;
}) {
  const fam = familyFromMime(asset.contentType);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabledReason}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-md border p-2 text-left transition",
        disabled ? "cursor-not-allowed border-rule bg-warm/30 opacity-60"
                 : "cursor-pointer border-rule bg-paper hover:border-brand-violet hover:shadow-sm",
      )}
    >
      {fam === "image" ? (
        <img src={asset.blobUrl} alt={asset.filename}
          className="h-24 w-full rounded object-cover" loading="lazy" />
      ) : (
        <div className="flex h-24 w-full items-center justify-center rounded bg-warm2/60 text-mute">
          <Icon name="doc" size={28} strokeWidth={1.5} />
        </div>
      )}
      <div className="min-w-0 w-full">
        <div className="truncate text-[12px] font-semibold text-ink" title={asset.filename}>
          {asset.filename}
        </div>
        <div className="mono-cap text-[10px] tracking-[.04em] text-mute">
          {humanBytes(asset.sizeBytes)} · {asset.contentType.split("/").pop()}
        </div>
      </div>
    </button>
  );
}

// ── Upload tab ───────────────────────────────────────────────────────────

function UploadPane({
  channel, canAddToLibrary, onSelected,
}: {
  channel: TwChannel;
  canAddToLibrary: boolean;
  onSelected: (asset: MediaAsset) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLibrary, setIsLibrary] = useState(false);
  const [folderId, setFolderId] = useState<string | "">("");
  const [folders, setFolders] = useState<MediaFolder[]>([]);

  useEffect(() => {
    if (canAddToLibrary) listMediaFolders().then(setFolders).catch(() => {});
  }, [canAddToLibrary]);

  const validation = useMemo(() => {
    if (!file) return null;
    return validateMediaForChannel(channel, file.type, file.size);
  }, [file, channel]);

  const submit = useCallback(async () => {
    if (!file || busy) return;
    if (validation && !validation.ok) { setError(validation.reason); return; }
    setBusy(true);
    setError(null);
    try {
      const asset = await uploadMediaAsset(file, {
        isLibrary,
        folderId: isLibrary ? (folderId || null) : null,
      });
      onSelected(asset);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [file, isLibrary, folderId, busy, validation, onSelected]);

  return (
    <div>
      <label
        htmlFor="mp-file"
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition",
          file ? "border-brand-violet bg-brand-violet/5" : "border-rule2 bg-warm/30 hover:border-brand-violet",
        )}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) setFile(f);
        }}
      >
        <Icon name="plus" size={24} strokeWidth={2} className="mb-2 text-brand-violet" />
        <div className="text-[13.5px] font-semibold text-ink">
          {file ? file.name : "Drop a file or click to choose"}
        </div>
        <div className="mono-cap mt-1 text-[10px] tracking-[.04em] text-hint">
          {file
            ? `${humanBytes(file.size)} · ${file.type || "unknown"}`
            : "Images, PDFs, videos, docs, zip"}
        </div>
        <input
          id="mp-file"
          type="file"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      {validation && !validation.ok && (
        <div className="mt-3 rounded-md border border-state-warn/40 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">
          {validation.reason}
        </div>
      )}

      {canAddToLibrary && (
        <div className="mt-4 space-y-2 rounded-md border border-rule bg-warm/20 p-3 text-[12.5px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isLibrary}
              onChange={(e) => setIsLibrary(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-violet"
            />
            <span>Also save to the shared media library</span>
          </label>
          {isLibrary && folders.length > 0 && (
            <div className="ml-6">
              <label className="mono-cap text-[10px] tracking-[.04em] text-hint">Folder</label>
              <select
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1 text-[12.5px]"
              >
                <option value="">— Uncategorized —</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-state-warn/40 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">
          {error}
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!file || busy || (validation !== null && !validation.ok)}
          className="btn-grad disabled:opacity-60"
        >
          {busy ? "Uploading…" : "Attach"}
        </button>
      </div>
    </div>
  );
}
