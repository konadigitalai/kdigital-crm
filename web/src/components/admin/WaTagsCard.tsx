"use client";

import { useState } from "react";
import { createWaTag, deleteWaTag } from "@/lib/api";
import type { WaTag } from "@/lib/types";

const PRESET_COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#10b981", "#06b6d4",
  "#6b7280",
];

export function WaTagsCard({
  initialTags, canManage,
}: { initialTags: WaTag[]; canManage: boolean }) {
  const [tags, setTags] = useState<WaTag[]>(initialTags);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleAdd() {
    if (!canManage) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true); setErr(null);
    try {
      const tag = await createWaTag({ name: trimmed, color });
      setTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
      setName("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!canManage) return;
    if (!confirm("Delete this tag? It will be removed from all conversations.")) return;
    setBusy(true);
    try {
      await deleteWaTag(id);
      setTags((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[16px] border border-rule bg-paper p-6">
      <div className="mb-4">
        <h2 className="text-[18px] font-semibold text-ink">Tags</h2>
        <p className="mt-1 text-[13px] text-mute">
          Apply colored labels to inbox contacts. Tags are tenant-scoped and reusable across conversations.
        </p>
      </div>

      {/* Add */}
      {canManage && (
        <div className="mb-4 rounded-[10px] border border-rule p-3">
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name (e.g. Hot, VIP, Stale)"
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              maxLength={48}
              className="flex-1 rounded-md border border-rule bg-paper px-3 py-1.5 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
            />
            <button onClick={handleAdd} disabled={busy || !name.trim()}
              className="rounded-md bg-brand-violet px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              Add
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="mono-cap mr-1 text-[10px] font-semibold tracking-[.1em] text-mute">color</span>
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={"h-6 w-6 rounded-full ring-2 transition " + (color === c ? "ring-ink" : "ring-transparent hover:ring-rule2")}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          {err && <div className="mt-2 text-[12px] text-state-bad">{err}</div>}
        </div>
      )}

      {/* List */}
      <div className="flex flex-wrap gap-2">
        {tags.length === 0 ? (
          <div className="text-[13px] text-mute">No tags yet.</div>
        ) : tags.map((t) => (
          <div key={t.id}
            className="group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold ring-1 ring-inset"
            style={{ backgroundColor: `${t.color}15`, color: t.color, borderColor: `${t.color}40` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
            {t.name}
            {canManage && (
              <button
                onClick={() => handleDelete(t.id)}
                title="Delete tag"
                className="-mr-1 ml-0.5 hidden rounded-full px-1 text-[14px] leading-none opacity-60 hover:opacity-100 group-hover:inline-block"
                style={{ color: t.color }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
