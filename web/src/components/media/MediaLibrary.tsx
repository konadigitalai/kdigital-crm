"use client";

// Admin media library — folder sidebar + asset grid. Admins can create,
// rename, delete folders. Uploaders can upload; owners + admins can
// rename/delete their own assets. Non-library ad-hoc assets don't show
// here (fetched with scope=library).

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  createMediaFolder, deleteMediaAsset, deleteMediaFolder,
  listMediaAssets, listMediaFolders, renameMediaAsset,
  renameMediaFolder, uploadMediaAsset,
} from "@/lib/api";
import type { MediaAsset, MediaFolder } from "@/lib/types";
import { familyFromMime, humanBytes } from "./mediaShared";

export function MediaLibrary({
  canUpload, canManage,
}: {
  canUpload: boolean;
  canManage: boolean;
}) {
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [f, a] = await Promise.all([
        listMediaFolders(),
        listMediaAssets({ scope: "library", folderId: activeFolder ?? undefined }),
      ]);
      setFolders(f);
      setAssets(a);
      setLoading(false);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }, [activeFolder]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function onCreateFolder() {
    const name = window.prompt("Folder name:")?.trim();
    if (!name) return;
    try { await createMediaFolder(name); await refresh(); }
    catch (err) { setError((err as Error).message); }
  }

  async function onRenameFolder(f: MediaFolder) {
    const name = window.prompt("Rename folder:", f.name)?.trim();
    if (!name || name === f.name) return;
    try { await renameMediaFolder(f.id, name); await refresh(); }
    catch (err) { setError((err as Error).message); }
  }

  async function onDeleteFolder(f: MediaFolder) {
    if (!window.confirm(`Delete "${f.name}"? Files inside are unaffected — they'll move to Uncategorized.`)) return;
    try {
      await deleteMediaFolder(f.id);
      if (activeFolder === f.id) setActiveFolder(null);
      await refresh();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="rounded-2xl border border-rule bg-paper">
      <div className="flex items-center justify-between border-b border-rule px-5 py-3">
        <h1 className="font-serif text-[22px] font-normal tracking-[-.01em]">Media library</h1>
        {canUpload && (
          <UploadButton folders={folders} activeFolder={activeFolder} onUploaded={refresh} />
        )}
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-0 min-h-[420px]">
        <aside className="border-r border-rule px-3 py-3 text-[13px]">
          <div className="mb-2 flex items-center justify-between">
            <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Folders</span>
            {canManage && (
              <button
                type="button"
                onClick={onCreateFolder}
                className="text-mute hover:text-brand-violet"
                title="New folder"
              >
                <Icon name="plus" size={14} strokeWidth={2.2} />
              </button>
            )}
          </div>
          <FolderRow active={activeFolder === null} onClick={() => setActiveFolder(null)}>
            All files
          </FolderRow>
          {folders.map((f) => (
            <div key={f.id} className="group flex items-center gap-1">
              <FolderRow
                active={activeFolder === f.id}
                onClick={() => setActiveFolder(f.id)}
              >
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="font-mono text-[10px] text-mute">{f.assetCount}</span>
              </FolderRow>
              {canManage && (
                <div className="flex opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => onRenameFolder(f)}
                    className="text-mute hover:text-brand-violet"
                    title="Rename"
                  ><Icon name="settings" size={12} strokeWidth={2} /></button>
                  <button
                    onClick={() => onDeleteFolder(f)}
                    className="text-mute hover:text-state-warn"
                    title="Delete folder"
                  ><Icon name="plus" size={12} strokeWidth={2.2} className="rotate-45" /></button>
                </div>
              )}
            </div>
          ))}
        </aside>

        <main className="p-4">
          {error && (
            <div className="mb-3 rounded-md border border-state-warn/40 bg-state-warn/10 p-3 text-[12.5px] text-state-warn">
              {error}
            </div>
          )}
          {loading ? (
            <div className="p-6 text-center text-[12.5px] text-mute">Loading…</div>
          ) : assets.length === 0 ? (
            <div className="rounded-md border border-dashed border-rule2 p-8 text-center text-[12.5px] text-mute">
              No files in {activeFolder ? "this folder" : "the library"} yet.
              {canUpload && " Upload one to get started."}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 md:grid-cols-4 xl:grid-cols-5">
              {assets.map((a) => (
                <AssetCard
                  key={a.id}
                  asset={a}
                  canManage={canManage}
                  onChanged={refresh}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function FolderRow({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition",
        active ? "bg-brand-violet text-white" : "text-ink2 hover:bg-warm/60",
      )}
    >
      {children}
    </button>
  );
}

function UploadButton({
  folders, activeFolder, onUploaded,
}: {
  folders: MediaFolder[];
  activeFolder: string | null;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadMediaAsset(file, { isLibrary: true, folderId: activeFolder });
      onUploaded();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  void folders;
  return (
    <label className={cn(
      "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-brand-violet bg-brand-violet px-3 py-1.5 text-[12.5px] font-semibold text-white transition",
      busy ? "opacity-60 cursor-wait" : "hover:bg-brand-violet/90",
    )}>
      <Icon name="plus" size={12} strokeWidth={2.2} />
      {busy ? "Uploading…" : "Upload"}
      <input type="file" className="hidden" onChange={onPick} disabled={busy} />
      {error && <span className="ml-2 text-[10.5px] text-state-warn">{error}</span>}
    </label>
  );
}

function AssetCard({
  asset, canManage, onChanged,
}: {
  asset: MediaAsset;
  canManage: boolean;
  onChanged: () => void;
}) {
  const fam = familyFromMime(asset.contentType);
  async function onRename() {
    const next = window.prompt("Rename file:", asset.filename)?.trim();
    if (!next || next === asset.filename) return;
    try { await renameMediaAsset(asset.id, { filename: next }); onChanged(); }
    catch (err) { window.alert((err as Error).message); }
  }
  async function onDelete() {
    if (!window.confirm(`Delete "${asset.filename}"?`)) return;
    try { await deleteMediaAsset(asset.id); onChanged(); }
    catch (err) { window.alert((err as Error).message); }
  }
  return (
    <div className="group flex flex-col overflow-hidden rounded-lg border border-rule bg-warm/30">
      {fam === "image" ? (
        <img src={asset.blobUrl} alt={asset.filename}
          className="h-32 w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-32 w-full items-center justify-center bg-warm2/60 text-mute">
          <Icon name="doc" size={30} strokeWidth={1.5} />
        </div>
      )}
      <div className="flex flex-col gap-1 p-2 text-[12px]">
        <div className="truncate font-semibold text-ink" title={asset.filename}>{asset.filename}</div>
        <div className="mono-cap text-[9.5px] tracking-[.04em] text-mute">
          {humanBytes(asset.sizeBytes)} · {asset.contentType.split("/").pop()}
        </div>
        <div className="mt-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={onRename}
            className="rounded border border-rule bg-paper px-1.5 py-0.5 text-[10.5px] text-ink2 hover:border-brand-violet hover:text-brand-violet"
          >Rename</button>
          {canManage && (
            <button
              onClick={onDelete}
              className="rounded border border-rule bg-paper px-1.5 py-0.5 text-[10.5px] text-ink2 hover:border-state-warn hover:text-state-warn"
            >Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}
