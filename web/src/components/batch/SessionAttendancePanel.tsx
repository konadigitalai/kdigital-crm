"use client";

// Attendance capture for one persisted batch_session. Loads the roster, lets
// the trainer mark each learner (present / absent / late / excused) with a
// segmented control, and PUTs only the rows that carry a chosen status. Rendered
// as a centered overlay dialog, mirroring CloseCaseDialog's overlay pattern.

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf } from "@/lib/ui";
import { getSessionRoster, saveSessionAttendance } from "@/lib/api";
import type { AttendanceRosterEntry, AttendanceStatus } from "@/lib/types";

const STATUS_OPTIONS: { value: AttendanceStatus; label: string; cls: string }[] = [
  { value: "present", label: "Present", cls: "bg-state-ok text-white" },
  { value: "absent",  label: "Absent",  cls: "bg-state-warn text-white" },
  { value: "late",    label: "Late",    cls: "bg-state-amber text-white" },
  { value: "excused", label: "Excused", cls: "bg-brand-violet text-white" },
];

export function SessionAttendancePanel({
  sessionId, onClose, onSaved,
}: {
  sessionId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roster, setRoster] = useState<AttendanceRosterEntry[] | null>(null);
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getSessionRoster(sessionId)
      .then((r) => {
        if (cancelled) return;
        setRoster(r);
        // Seed from any status already recorded; unmarked learners stay unset.
        const seed: Record<string, AttendanceStatus> = {};
        for (const e of r) if (e.status) seed[e.partyId] = e.status;
        setMarks(seed);
      })
      .catch((err) => { if (!cancelled) setLoadError((err as Error).message); });
    return () => { cancelled = true; };
  }, [sessionId]);

  function setStatus(partyId: string, status: AttendanceStatus) {
    setMarks((prev) => ({ ...prev, [partyId]: status }));
  }

  function markAllPresent() {
    if (!roster) return;
    const next: Record<string, AttendanceStatus> = {};
    for (const e of roster) next[e.partyId] = "present";
    setMarks(next);
  }

  const chosen = Object.keys(marks).length;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = Object.entries(marks).map(([partyId, status]) => ({ partyId, status }));
      await saveSessionAttendance(sessionId, payload);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 flex max-h-[calc(100vh-96px)] w-full max-w-[560px] flex-col rounded-2xl border border-rule bg-paper shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-rule p-7 pb-4">
          <div>
            <h2 className="font-serif text-[24px] font-normal leading-tight tracking-[-.01em]">Take attendance</h2>
            <p className="mt-1 text-[12.5px] text-mute">
              Mark each learner. Only the rows you set are saved.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-rule px-7 py-2.5">
          <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
            {roster ? `${chosen}/${roster.length} marked` : "Loading…"}
          </span>
          <button
            type="button"
            onClick={markAllPresent}
            disabled={!roster || roster.length === 0}
            className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink disabled:opacity-50"
          >
            <Icon name="check" size={13} strokeWidth={2} />
            Mark all present
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-4">
          {loadError ? (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {loadError}
            </div>
          ) : !roster ? (
            <div className="py-8 text-center text-[13px] text-mute">Loading roster…</div>
          ) : roster.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-mute">No learners assigned to this batch yet.</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {roster.map((e) => (
                <div key={e.partyId} className="flex items-center gap-3">
                  <span className={cn("flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[9.5px] font-bold text-white", avatarGradClass[gradFor(e.name)])}>
                    {initialsOf(e.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-ink">{e.name}</div>
                    {e.email && <div className="truncate text-[11px] text-mute">{e.email}</div>}
                  </div>
                  <div className="inline-flex flex-shrink-0 rounded-full border border-rule bg-paper p-0.5">
                    {STATUS_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setStatus(e.partyId, o.value)}
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                          marks[e.partyId] === o.value ? o.cls : "text-ink2 hover:bg-warm",
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-rule p-7 pt-4">
          {error && (
            <div className="mb-3 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button
              type="button"
              onClick={save}
              disabled={saving || chosen === 0}
              className="btn-grad disabled:opacity-50"
            >
              {saving ? "Saving…" : `Save attendance${chosen > 0 ? ` (${chosen})` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
