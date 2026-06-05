"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { updateCourseAssignmentStatus } from "@/lib/api";
import type { EnrolmentStatus } from "@/lib/types";

const STATUSES: EnrolmentStatus[] = ["active", "completed", "dropped", "deferred"];
const STATUS_CLS: Record<EnrolmentStatus, string> = {
  active:    "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  dropped:   "bg-[rgba(217,83,79,.10)]  text-state-warn",
  deferred:  "bg-[rgba(224,138,30,.12)] text-state-amber",
};

export function CourseStatusBadgeClient({
  partyId, courseAssignmentId, current,
}: {
  partyId: string;
  courseAssignmentId: string;
  current: EnrolmentStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function set(status: EnrolmentStatus) {
    if (status === current) { setOpen(false); return; }
    setBusy(true);
    try {
      await updateCourseAssignmentStatus(partyId, courseAssignmentId, status);
      router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className={cn("mono-cap inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold transition disabled:opacity-50", STATUS_CLS[current])}
      >
        {current}
        <span className="text-[8px]">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-[140px] overflow-hidden rounded-lg border border-rule bg-paper shadow-card">
            {STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => set(s)}
                className={cn(
                  "block w-full px-3 py-1.5 text-left text-[12px] capitalize transition hover:bg-warm",
                  s === current && "bg-warm font-semibold",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
