"use client";

// Batch detail — a card-based record page: header + quick actions, an "Edify
// Agent" next-best-action banner, a Delivery/Schedule/P&L column and a
// Risk/Linked-records column, and the persisted batch_sessions timeline below.
// Trainers materialize sessions from the schedule, mark them delivered,
// publish recordings, and capture attendance here. A batch's structural
// fields are edited in Admin · Batches; this page only mutates its sessions +
// attendance.

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { avatarGradClass, gradFor, initialsOf, shortName } from "@/lib/ui";
import { getBatchDetailSessions, patchBatchSession } from "@/lib/api";
import type { BatchDetailData, BatchSessionDetail } from "@/lib/types";
import { MaterializeSessionsButton } from "./MaterializeSessionsButton";
import { SessionAttendancePanel } from "./SessionAttendancePanel";

const STATUS_CLS: Record<string, string> = {
  upcoming:  "bg-[rgba(31,63,207,.08)]  text-brand-blue",
  running:   "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  cancelled: "bg-[rgba(217,83,79,.10)]  text-state-warn",
};

const SESSION_STATUS_CLS: Record<string, string> = {
  planned:   "bg-warm2                  text-mute",
  delivered: "bg-[rgba(46,158,106,.10)] text-state-ok",
  cancelled: "bg-[rgba(217,83,79,.10)]  text-state-warn",
};

const IST = "Asia/Kolkata";
const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: IST, day: "2-digit", month: "short", year: "2-digit" });

const RISK_THRESHOLD = 80;

function slotTitle(slot: string | null): string | null {
  if (!slot) return null;
  return slot[0]!.toUpperCase() + slot.slice(1);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return dateFmt.format(d);
}

/** "08 Jul 26" — the compact form used in the Schedule card. */
function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return shortDateFmt.format(d);
}

function fmtTimeRange(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  return `${start ?? "—"}–${end ?? "—"}`;
}

function fmtPct(pct: number | null): string {
  return pct != null ? `${pct}%` : "—";
}

export function BatchDetail({
  detail, initialSessions, canWrite,
}: {
  detail: BatchDetailData;
  initialSessions: BatchSessionDetail[];
  canWrite: boolean;
}) {
  const [sessions, setSessions] = useState<BatchSessionDetail[]>(initialSessions);
  const [attendanceFor, setAttendanceFor] = useState<string | null>(null);

  async function reload() {
    try {
      setSessions(await getBatchDetailSessions(detail.id));
    } catch { /* keep current view on transient failure */ }
  }

  const title = detail.code ?? detail.name;
  const subtitle = detail.code ? detail.name : null;
  const metaLine = [detail.code ? `BAT-${detail.code}` : null, detail.courseName].filter(Boolean).join(" · ") || "—";

  const coverageWarn = detail.coveragePct != null && detail.coveragePct < RISK_THRESHOLD;
  const attendanceWarn = detail.attendancePct != null && detail.attendancePct < RISK_THRESHOLD;
  const recordingWarn = detail.recordingSlaPct != null && detail.recordingSlaPct < RISK_THRESHOLD;

  return (
    <>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-[34px] font-normal leading-none tracking-[-.01em]">{title}</h1>
          {subtitle && <div className="mt-1.5 truncate text-[14px] text-mute">{subtitle}</div>}
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[11px] tracking-[.06em] text-mute">{metaLine}</span>
            <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold capitalize", STATUS_CLS[detail.status] ?? "bg-warm2 text-mute")}>
              {detail.status}
            </span>
            {!detail.staffed && <WarnPill>Unstaffed</WarnPill>}
          </div>
        </div>
        <Link
          href="/batches"
          className="mono-cap mt-1.5 flex-shrink-0 text-[11px] font-semibold tracking-[.08em] text-mute transition hover:text-ink"
        >
          ← Back
        </Link>
      </div>

      {/* ── Action row ──────────────────────────────────────────────────── */}
      {canWrite && (
        <div className="mb-6 flex flex-wrap items-center gap-2.5">
          <Link href="/learners" className="btn-grad">
            <Icon name="user-plus" size={14} strokeWidth={2} />
            Assign learners
          </Link>
          <MaterializeSessionsButton batchId={detail.id} onDone={reload} />
          <button
            type="button"
            disabled
            title="Coming soon"
            className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-hint opacity-60"
          >
            <Icon name="message-square" size={13} strokeWidth={2} />
            Message cohort
          </button>
          <Link
            href="/admin/cohorts"
            className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
          >
            <Icon name="graduation-cap" size={13} strokeWidth={2} />
            Assign trainer
          </Link>
        </div>
      )}

      {/* ── Next best action ────────────────────────────────────────────── */}
      <div className="mb-6 rounded-[16px] border border-brand-violet/15 bg-grad-soft p-5">
        <div className="mono-cap mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[.14em] text-brand-violet">
          <Icon name="spark" size={13} strokeWidth={2} />
          Next best action · Edify Agent
        </div>
        <div className="text-[13.5px] leading-[1.55] text-ink2">{detail.nba.text}</div>
        <div className="mt-2 text-[13.5px] font-bold tracking-[-.005em] text-ink">→ {detail.nba.action}</div>
      </div>

      {/* ── Delivery / Schedule / P&L  +  Risk / Linked records ─────────── */}
      <div className="mb-8 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="flex flex-col gap-5 lg:col-span-2">
          <div className="acard">
            <SectionLabel>Delivery</SectionLabel>
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
              <StatTile label="Learners" value={`${detail.activeCount}${detail.seats != null ? `/${detail.seats}` : ""}`} />
              <StatTile label="Sessions" value={`${detail.sessionsDelivered}/${detail.sessionsTotal}`} />
              <StatTile label="Coverage" value={fmtPct(detail.coveragePct)} warn={coverageWarn} />
              <StatTile label="Attendance" value={fmtPct(detail.attendancePct)} warn={attendanceWarn} />
              <StatTile label="Recording SLA" value={fmtPct(detail.recordingSlaPct)} warn={recordingWarn} />
              <div className="rounded-[12px] bg-warm/60 p-3.5">
                <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.12em] text-mute">Trainer</div>
                {detail.trainerName ? (
                  <div className="flex items-center gap-2">
                    <span className={cn("flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white", avatarGradClass[gradFor(detail.trainerName)])}>
                      {initialsOf(detail.trainerName)}
                    </span>
                    <span className="truncate text-[14px] font-bold tracking-[-.005em] text-ink">{shortName(detail.trainerName)}</span>
                  </div>
                ) : (
                  <WarnPill>None</WarnPill>
                )}
              </div>
            </div>
          </div>

          <div className="acard">
            <SectionLabel>Schedule</SectionLabel>
            <div className="flex flex-col">
              <Row k="Slot · Time" v={[slotTitle(detail.slot), detail.timeLabel].filter(Boolean).join(" · ") || "—"} />
              <Row k="Days" v={detail.schedule ?? "—"} />
              <Row k="Mode" v="—" muted />
              <Row k="Started" v={fmtShortDate(detail.startDate)} />
              <Row k="Ends" v={detail.endDate ? `${fmtShortDate(detail.endDate)} (est.)` : "—"} />
              <Row k="Timezone" v={`${detail.timezone} · IST`} />
            </div>
          </div>

          <div className="acard">
            <div className="mono-cap mb-4 flex items-center gap-1.5 text-[10px] font-semibold tracking-[.14em] text-mute">
              <span>P&amp;L 🔒</span>
              <span className="text-hint">· Finance &amp; admin only</span>
            </div>
            <div className="grid grid-cols-3 gap-3.5">
              <LockedTile label="Revenue" />
              <LockedTile label="Trainer cost" />
              <LockedTile label="Contribution" />
            </div>
            <div className="mt-3 text-[11.5px] text-hint">Finance module coming soon.</div>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div className="acard">
            <SectionLabel>Risk</SectionLabel>
            <div className="grid grid-cols-2 gap-3.5">
              <StatTile label="At-risk learners" value={String(detail.atRisk)} warn={detail.atRisk > 0} />
              <StatTile label="Moved out" value={String(detail.movedOut)} />
            </div>
          </div>

          <div className="acard">
            <SectionLabel>Linked records</SectionLabel>
            <div className="flex flex-col">
              <LinkRow k="Curriculum" href="#" label="View in Learning →" disabled />
              <RowNode k="Trainer">
                {detail.trainerName ? (
                  <span className="font-semibold text-ink">{detail.trainerName}</span>
                ) : (
                  <WarnPill>Not assigned</WarnPill>
                )}
              </RowNode>
              <LinkRow k="Learners" href="/learners" label={`${detail.activeCount} assigned →`} />
              <LinkRow k="Cases" href="/cases" label="View in Cases →" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Sessions ────────────────────────────────────────────────────── */}
      <div className="mb-4 flex items-center gap-[9px]">
        <span className="h-[1.5px] w-[18px] bg-brand-violet" />
        <span className="mono-cap text-[11px] font-semibold tracking-[.16em] text-brand-violet">
          Sessions · {sessions.length}
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-rule p-12 text-center">
          <div className="text-[13px] text-mute">
            No sessions yet{canWrite ? " — use Schedule sessions above." : "."}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              canWrite={canWrite}
              onChanged={reload}
              onTakeAttendance={() => setAttendanceFor(s.id)}
            />
          ))}
        </div>
      )}

      {attendanceFor && (
        <SessionAttendancePanel
          sessionId={attendanceFor}
          onClose={() => setAttendanceFor(null)}
          onSaved={reload}
        />
      )}
    </>
  );
}

// ─── Shared card bits ───────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono-cap mb-4 text-[10px] font-semibold tracking-[.14em] text-mute">
      {children}
    </div>
  );
}

function StatTile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-[12px] bg-warm/60 p-3.5">
      <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      <div className={cn("text-[20px] font-bold leading-none tracking-[-.01em]", warn ? "text-state-warn" : "text-ink")}>
        {warn ? `⚠ ${value}` : value}
      </div>
    </div>
  );
}

function LockedTile({ label }: { label: string }) {
  return (
    <div className="rounded-[12px] bg-warm/60 p-3.5">
      <div className="mono-cap mb-1.5 text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      <div className="flex items-center gap-1.5 text-[20px] font-bold leading-none tracking-[-.01em] text-hint">
        <span>🔒</span>
        <span>—</span>
      </div>
    </div>
  );
}

function WarnPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="mono-cap inline-flex items-center gap-1 rounded-full bg-[rgba(217,83,79,.10)] px-2 py-0.5 text-[9.5px] font-semibold text-state-warn">
      ⚠ {children}
    </span>
  );
}

function Row({ k, v, muted }: { k: string; v: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      <span className={cn("text-right font-semibold", muted ? "text-hint" : "text-ink")}>{v}</span>
    </div>
  );
}

function RowNode({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function LinkRow({
  k, href, label, disabled,
}: {
  k: string;
  href: string;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-rule py-[9px] text-[13px] last:border-b-0">
      <span className="font-medium text-mute">{k}</span>
      {disabled ? (
        <span className="text-right font-semibold text-hint">{label}</span>
      ) : (
        <Link href={href} className="text-right font-semibold text-brand-violet hover:underline">
          {label}
        </Link>
      )}
    </div>
  );
}

// ─── Session row ────────────────────────────────────────────────────────────

function SessionRow({
  session, canWrite, onChanged, onTakeAttendance,
}: {
  session: BatchSessionDetail;
  canWrite: boolean;
  onChanged: () => void;
  onTakeAttendance: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const published = session.recordingPublishedAt != null;

  async function markDelivered() {
    setBusy(true);
    setError(null);
    try {
      await patchBatchSession(session.id, { status: "delivered" });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publishRecording() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await patchBatchSession(session.id, { recordingUrl: url.trim(), recordingPublishedAt: true });
      setUrl("");
      setPublishing(false);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pct = session.markedCount > 0
    ? Math.round((session.presentCount / session.markedCount) * 100)
    : 0;

  return (
    <div className="grid grid-cols-[minmax(150px,1fr)_auto] items-center gap-4 border-b border-rule px-5 py-3.5 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold tracking-[-.005em] text-ink">{fmtDate(session.sessionDate)}</div>
          <div className="font-mono text-[10.5px] text-mute">{fmtTimeRange(session.startTime, session.endTime)}</div>
        </div>

        <span className={cn("mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold capitalize", SESSION_STATUS_CLS[session.status] ?? "bg-warm2 text-mute")}>
          {session.status}
        </span>

        {/* Recording indicator */}
        {published ? (
          session.recordingUrl ? (
            <a
              href={session.recordingUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-state-ok hover:underline"
            >
              <Icon name="check" size={12} strokeWidth={2.4} />
              Recorded
            </a>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-state-ok">
              <Icon name="check" size={12} strokeWidth={2.4} />
              Recorded
            </span>
          )
        ) : session.status === "delivered" ? (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-state-amber">
            <Icon name="info" size={12} strokeWidth={2.2} />
            No recording
          </span>
        ) : (
          <span className="text-[11.5px] text-hint">—</span>
        )}

        {/* Attendance summary */}
        <div className="min-w-[92px]">
          <div className="mb-1 font-mono text-[10.5px] text-ink2">
            {session.presentCount}<span className="text-hint">/{session.markedCount}</span>
            <span className="ml-1 text-hint">present</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-warm2">
            <div className="h-full rounded-full bg-grad" style={{ width: `${session.markedCount > 0 ? Math.max(2, pct) : 0}%` }} />
          </div>
        </div>
      </div>

      {canWrite && (
        <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            {session.status === "planned" && (
              <button
                type="button"
                onClick={markDelivered}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink disabled:opacity-50"
              >
                <Icon name="check" size={12} strokeWidth={2.2} />
                Mark delivered
              </button>
            )}
            {!published && (
              <button
                type="button"
                onClick={() => setPublishing((p) => !p)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition",
                  publishing ? "border-brand-violet bg-brand-violet/10 text-brand-violet" : "border-rule bg-paper text-ink2 hover:border-rule2 hover:text-ink",
                )}
              >
                <Icon name="send" size={12} strokeWidth={2.2} />
                Publish recording
              </button>
            )}
            <button
              type="button"
              onClick={onTakeAttendance}
              className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 transition hover:border-rule2 hover:text-ink"
            >
              <Icon name="users" size={12} strokeWidth={2.2} />
              Take attendance
            </button>
          </div>

          {publishing && !published && (
            <div className="flex items-center gap-2">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Recording URL"
                className="w-[220px] rounded-full border border-rule bg-paper px-3 py-1 text-[12px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
              />
              <button
                type="button"
                onClick={publishRecording}
                disabled={busy || !url.trim()}
                className="btn-grad !px-3 !py-1 !text-[12px] disabled:opacity-50"
              >
                {busy ? "…" : "Publish"}
              </button>
            </div>
          )}

          {error && <span className="text-[11px] text-state-warn">{error}</span>}
        </div>
      )}
    </div>
  );
}
