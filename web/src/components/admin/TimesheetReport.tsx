"use client";

// Admin timesheet report — pivot grid (rows = users, cols = dates) +
// filters (date range, users) + CSV export.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { getTimesheetReport } from "@/lib/api";
import type { AdminUser, TimesheetReportRow } from "@/lib/types";

interface Props {
  users: AdminUser[];
  initialFrom: string;
  initialTo: string;
  initialRows: TimesheetReportRow[];
}

function fmtDur(mins: number): string {
  if (!mins) return "—";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function csvCell(s: string): string {
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function todayISO(): string {
  return new Date(Date.now() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const RANGE_PRESETS: { label: string; compute: () => { from: string; to: string } }[] = [
  { label: "Today",      compute: () => { const t = todayISO(); return { from: t, to: t }; } },
  { label: "This week",  compute: () => {
    const t = todayISO(); const dow = new Date(`${t}T12:00:00Z`).getUTCDay();
    const sinceMon = (dow + 6) % 7;
    return { from: addDays(t, -sinceMon), to: addDays(t, 6 - sinceMon) };
  } },
  { label: "Last 7 days", compute: () => { const t = todayISO(); return { from: addDays(t, -6), to: t }; } },
  { label: "Last 30",     compute: () => { const t = todayISO(); return { from: addDays(t, -29), to: t }; } },
  { label: "This month",  compute: () => {
    const t = todayISO(); const ym = t.slice(0, 7);
    const last = new Date(`${ym}-01T12:00:00Z`); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
    return { from: `${ym}-01`, to: last.toISOString().slice(0, 10) };
  } },
];

function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    cur = addDays(cur, 1);
    if (out.length > 366) break; // hard guardrail
  }
  return out;
}

export function TimesheetReport({ users, initialFrom, initialTo, initialRows }: Props) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo]     = useState(initialTo);
  const [pickedUsers, setPickedUsers] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<TimesheetReportRow[]>(initialRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refetch(nextFrom: string, nextTo: string, uIds: Set<string>) {
    setBusy(true); setError(null);
    try {
      const out = await getTimesheetReport(nextFrom, nextTo, { userIds: Array.from(uIds) });
      setRows(out);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (from !== initialFrom || to !== initialTo) {
      refetch(from, to, pickedUsers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  function toggleUser(id: string) {
    const next = new Set(pickedUsers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPickedUsers(next);
    refetch(from, to, next);
  }

  // ── Aggregations ──────────────────────────────────────────────────────
  const userIdsInResult = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.userId);
    pickedUsers.forEach((id) => s.add(id));
    return s;
  }, [rows, pickedUsers]);

  const visibleUsers = useMemo(
    () => users
      .filter((u) => userIdsInResult.has(u.id))
      .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email)),
    [users, userIdsInResult],
  );

  const dateCols = useMemo(() => enumerateDates(from, to), [from, to]);

  // (userId, date) → mins
  const cellMins = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.userId}::${r.date}`, (m.get(`${r.userId}::${r.date}`) ?? 0) + r.mins);
    return m;
  }, [rows]);

  const totalsByUser = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.userId, (m.get(r.userId) ?? 0) + r.mins);
    return m;
  }, [rows]);

  const totalsByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.date, (m.get(r.date) ?? 0) + r.mins);
    return m;
  }, [rows]);

  const grandTotalMins = useMemo(() => rows.reduce((s, r) => s + r.mins, 0), [rows]);
  const totalBlocks    = useMemo(() => rows.reduce((s, r) => s + r.blocks, 0), [rows]);

  // CSV: flat (date, user, hours, blocks).
  function downloadCsv() {
    const header = ["date", "user", "email", "hours", "blocks"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([
        r.date,
        csvCell(r.userName ?? ""),
        csvCell(r.userEmail),
        (r.mins / 60).toFixed(2),
        String(r.blocks),
      ].join(","));
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `timesheet-report_${from}_to_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {/* Filter strip */}
      <div className="mb-4 rounded-2xl border border-rule bg-paper p-4">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="From">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </Field>
          <Field label="To">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex items-center gap-1.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => { const r = p.compute(); setFrom(r.from); setTo(r.to); }}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {busy && <span className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">syncing…</span>}
          <button onClick={downloadCsv} disabled={rows.length === 0} className="btn-grad disabled:opacity-50">
            <Icon name="arrow-right" size={13} strokeWidth={2.2} className="rotate-90" />
            Export CSV
          </button>
        </div>

        <div className="mt-3 rounded-[12px] border border-rule bg-warm/30 p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">Users</span>
            <span className="text-[10.5px] text-mute">{users.length} total</span>
          </div>
          <div className="flex max-h-[120px] flex-wrap gap-1 overflow-y-auto">
            {users
              .filter((u) => u.active)
              .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email))
              .map((u) => (
                <Chip
                  key={u.id}
                  on={pickedUsers.has(u.id)}
                  onClick={() => toggleUser(u.id)}
                  label={u.name ?? u.email}
                />
              ))}
          </div>
        </div>
      </div>

      {/* Totals strip */}
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Hours" value={fmtDur(grandTotalMins)} />
        <Stat label="Blocks" value={String(totalBlocks)} />
        <Stat label="Users" value={String(visibleUsers.length)} />
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">{error}</div>
      )}

      {/* Pivot grid: users × dates */}
      <div className="mb-6 overflow-x-auto rounded-2xl border border-rule bg-paper">
        {visibleUsers.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-mute">
            {rows.length === 0
              ? "No hours logged in this range yet."
              : "No data after filters — clear a chip to widen the result."}
          </div>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-rule bg-warm">
                <th className="sticky left-0 z-10 bg-warm px-4 py-2.5 text-left mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">
                  User
                </th>
                {dateCols.map((d) => (
                  <th key={d} className="px-3 py-2.5 text-right mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">
                    {new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right mono-cap text-[9.5px] font-semibold tracking-[.12em] text-ink">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => {
                const userTotal = totalsByUser.get(u.id) ?? 0;
                return (
                  <tr key={u.id} className="border-b border-rule last:border-b-0 hover:bg-warm/30">
                    <td className="sticky left-0 z-[5] bg-paper px-4 py-2 text-ink">
                      <div className="text-[13px] font-semibold">{u.name ?? u.email}</div>
                      <div className="mono-cap text-[9px] tracking-[.04em] text-mute">{u.role}</div>
                    </td>
                    {dateCols.map((d) => {
                      const v = cellMins.get(`${u.id}::${d}`) ?? 0;
                      return (
                        <td key={d} className={cn("px-3 py-2 text-right font-mono", v ? "text-ink" : "text-hint")}>
                          {fmtDur(v)}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2 text-right font-mono font-semibold text-ink">
                      {fmtDur(userTotal)}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-rule2 bg-warm font-semibold">
                <td className="sticky left-0 z-[5] bg-warm px-4 py-2.5 text-ink mono-cap text-[10px] tracking-[.12em]">Total</td>
                {dateCols.map((d) => (
                  <td key={d} className="px-3 py-2.5 text-right font-mono text-ink">
                    {fmtDur(totalsByDate.get(d) ?? 0)}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-right font-mono text-ink">{fmtDur(grandTotalMins)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* Flat list — full per-day breakdown for review */}
      <div className="rounded-2xl border border-rule bg-paper">
        <div className="border-b border-rule px-5 py-3 mono-cap text-[10px] font-semibold tracking-[.12em] text-brand-violet">
          Detail · {rows.length} aggregated row{rows.length === 1 ? "" : "s"}
        </div>
        {rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-[13px] text-mute">No rows.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-rule bg-warm/40">
                  <Th>Date</Th>
                  <Th>User</Th>
                  <Th align="right">Hours</Th>
                  <Th align="right">Blocks</Th>
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  .sort((a, b) => b.date.localeCompare(a.date) ||
                    (a.userName ?? "").localeCompare(b.userName ?? ""))
                  .map((r, i) => (
                    <tr key={`${r.userId}-${r.date}-${i}`} className="border-b border-rule last:border-b-0 hover:bg-warm/20">
                      <Td>
                        {new Date(`${r.date}T12:00:00Z`).toLocaleDateString("en-IN", {
                          day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
                        })}
                      </Td>
                      <Td>
                        <div className="font-semibold text-ink">{r.userName ?? r.userEmail}</div>
                        <div className="mono-cap text-[9px] tracking-[.04em] text-mute">{r.userEmail}</div>
                      </Td>
                      <Td align="right" mono>{(r.mins / 60).toFixed(2)}</Td>
                      <Td align="right" mono>{r.blocks}</Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

const inputCls = "w-[160px] rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      {children}
    </label>
  );
}

function Chip({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11.5px] font-semibold transition",
        on
          ? "border-brand-violet bg-brand-violet text-white"
          : "border-rule bg-paper text-ink2 hover:border-brand-violet hover:text-brand-violet",
      )}
    >
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-rule bg-paper px-4 py-3">
      <div className="mono-cap text-[9px] font-semibold tracking-[.12em] text-mute">{label}</div>
      <div className="mt-1 font-mono text-[20px] font-bold tracking-tight text-ink">{value}</div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={cn("px-4 py-2 mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute", align === "right" && "text-right")}>
      {children}
    </th>
  );
}
function Td({ children, align = "left", mono = false }: { children: React.ReactNode; align?: "left" | "right"; mono?: boolean }) {
  return (
    <td className={cn("px-4 py-2", align === "right" && "text-right", mono && "font-mono text-ink")}>
      {children}
    </td>
  );
}
