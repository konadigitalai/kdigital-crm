"use client";

import type { BatchSession } from "@/lib/types";

export function BatchSessionPopover({ session, onClose }: { session: BatchSession; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="my-12 w-full max-w-[440px] rounded-2xl border border-rule bg-paper p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="mono-cap mb-1 inline-flex items-center gap-1.5 rounded-full bg-brand-blue/10 px-2 py-0.5 text-[9px] font-semibold tracking-[.12em] text-brand-blue">
              <span aria-hidden>🎓</span> BATCH SESSION
            </div>
            <h2 className="font-serif text-[24px] font-normal leading-tight">{session.title}</h2>
            <p className="mt-1 text-[13px] text-mute">{eventTimeStr(session.startAt, session.endAt)}</p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">✕</button>
        </div>

        <div className="grid grid-cols-[100px_1fr] gap-y-2 text-[13px]">
          {session.programName && <>
            <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Program</div>
            <div className="text-ink">{session.programName}</div>
          </>}
          {session.courseName && <>
            <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Course</div>
            <div className="text-ink">{session.courseName}</div>
          </>}
          {session.trainerName && <>
            <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Trainer</div>
            <div className="text-ink">
              {session.trainerName}
              {session.isTrainer && <span className="ml-1.5 text-mute">(you)</span>}
            </div>
          </>}
          {session.coTrainerName && <>
            <div className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">Co-trainer</div>
            <div className="text-ink">
              {session.coTrainerName}
              {session.isCoTrainer && <span className="ml-1.5 text-mute">(you)</span>}
            </div>
          </>}
        </div>

        <div className="mt-5 border-t border-rule pt-3 text-[11.5px] text-mute">
          Recurring sessions follow the batch schedule. To change time or days, edit the batch in <span className="font-semibold text-ink">Admin · Batches</span>.
        </div>
      </div>
    </div>
  );
}

function eventTimeStr(startISO: string, endISO: string): string {
  const fmt = new Intl.DateTimeFormat("en-IN", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
  const t = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
  return `${fmt.format(new Date(startISO))} → ${t(endISO)} IST`;
}
