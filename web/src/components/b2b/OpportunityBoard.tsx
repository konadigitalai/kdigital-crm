"use client";

// The B2B pipeline, as a stage board.
//
// Two things this deliberately does that a plain table would not:
//
//   Days in stage is shown on every card. It comes from the server (the DB
//   stamps stage_updated_at on a real stage change, via trigger), so it is a
//   fact rather than something the UI infers from an activity feed. A deal
//   sitting in Proposal for 60 days is the single most useful signal here.
//
//   Closing is never silent. Dragging to Closed won / Closed lost sets the
//   close date server-side, because the DB refuses a closed deal without one.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { createOpportunity, updateOpportunity } from "@/lib/api";
import type {
  Account, Opportunity, OpportunityInput, OpportunityStage,
  OpportunityStageTotal, OpportunityType,
} from "@/lib/types";
import {
  DialogShell, ErrorNote, Field, Pill, formatMoney, humanise, inputCls,
} from "@/components/admin/formKit";

const OPEN_STAGES: OpportunityStage[] = ["qualification", "discovery", "proposal", "negotiation"];
const CLOSED_STAGES: OpportunityStage[] = ["closed_won", "closed_lost"];
const ALL_STAGES = [...OPEN_STAGES, ...CLOSED_STAGES];
const TYPES: OpportunityType[] = ["corporate_training", "hiring", "consulting", "renewal", "upsell"];

// A deal that has not moved in this long gets flagged. Not configurable yet —
// one number that makes the stale ones visible beats a setting nobody sets.
const STALE_DAYS = 30;

export function OpportunityBoard({
  initial, stageTotals, accounts,
}: {
  initial: Opportunity[];
  stageTotals: OpportunityStageTotal[];
  accounts: Account[];
}) {
  const router = useRouter();
  const [opportunities, setOpportunities] = useState<Opportunity[]>(initial);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Opportunity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const stages = showClosed ? ALL_STAGES : OPEN_STAGES;

  const byStage = useMemo(() => {
    const map = new Map<OpportunityStage, Opportunity[]>();
    for (const s of ALL_STAGES) map.set(s, []);
    for (const o of opportunities) map.get(o.stage)?.push(o);
    return map;
  }, [opportunities]);

  const totalsByStage = useMemo(() => {
    const map = new Map<string, OpportunityStageTotal>();
    for (const t of stageTotals) map.set(t.stage, t);
    return map;
  }, [stageTotals]);

  async function move(o: Opportunity, stage: OpportunityStage) {
    if (o.stage === stage) return;
    setBusy(o.workItemId); setError(null);
    try {
      // No actualCloseDate passed — the API stamps today when moving to a
      // closed stage and clears it when moving back out.
      const updated = await updateOpportunity(o.workItemId, { stage });
      setOpportunities((all) => all.map((x) => (x.workItemId === o.workItemId ? updated : x)));
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  async function onSubmit(input: OpportunityInput) {
    setBusy("form"); setError(null);
    try {
      if (editing) {
        const updated = await updateOpportunity(editing.workItemId, input);
        setOpportunities((all) => all.map((x) => (x.workItemId === editing.workItemId ? updated : x)));
      } else {
        const created = await createOpportunity(input);
        setOpportunities((all) => [created, ...all]);
      }
      setCreating(false); setEditing(null);
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const openValue = opportunities
    .filter((o) => !o.stage.startsWith("closed"))
    .reduce((sum, o) => sum + Number(o.value ?? 0), 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-mute">
          {opportunities.length} deal{opportunities.length === 1 ? "" : "s"}
          {" · "}{formatMoney(openValue)} open
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink2">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-violet"
            />
            Show closed
          </label>
          <button
            onClick={() => setCreating(true)}
            disabled={accounts.length === 0}
            title={accounts.length === 0 ? "Create an account first" : undefined}
            className="btn-grad disabled:opacity-50"
          >
            <Icon name="plus" size={14} strokeWidth={2.2} /> New opportunity
          </button>
        </div>
      </div>

      <ErrorNote message={error} />

      <div className={cn("mt-4 grid gap-4", showClosed ? "grid-cols-6" : "grid-cols-4")}>
        {stages.map((stage) => {
          const cards = byStage.get(stage) ?? [];
          const total = totalsByStage.get(stage);
          return (
            <div key={stage} className="flex min-h-[200px] flex-col rounded-2xl border border-rule bg-warm/40">
              <header className="border-b border-rule px-3 py-2.5">
                <div className="mono-cap flex items-center justify-between text-[9.5px] font-semibold tracking-[.1em] text-mute">
                  <span>{humanise(stage)}</span>
                  <span className="text-hint">{cards.length}</span>
                </div>
                <div className="mt-1 font-mono text-[12.5px] text-ink2">
                  {formatMoney(total?.value ?? 0)}
                </div>
              </header>

              <div className="flex flex-1 flex-col gap-2 p-2">
                {cards.length === 0 && (
                  <div className="px-2 py-6 text-center text-[11.5px] text-hint">Nothing here</div>
                )}
                {cards.map((o) => {
                  const stale = !o.stage.startsWith("closed") && o.daysInStage >= STALE_DAYS;
                  return (
                    <article
                      key={o.workItemId}
                      className={cn(
                        "rounded-[10px] border bg-paper p-2.5 transition",
                        busy === o.workItemId ? "opacity-50" : "hover:border-brand-violet/50",
                        stale ? "border-state-warn/40" : "border-rule",
                      )}
                    >
                      <button
                        onClick={() => setEditing(o)}
                        className="block w-full text-left"
                      >
                        <div className="truncate text-[12.5px] font-semibold">{o.name ?? o.number}</div>
                        <div className="mt-0.5 truncate text-[11px] text-mute">{o.accountName}</div>
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          <span className="font-mono text-[12px]">{formatMoney(o.value, o.currency)}</span>
                          {o.probability != null && (
                            <span className="text-[10.5px] text-mute">{o.probability}%</span>
                          )}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {stale && (
                            <Pill tone="warn" title={`No stage change in ${o.daysInStage} days`}>
                              {o.daysInStage}d stuck
                            </Pill>
                          )}
                          {!stale && !o.stage.startsWith("closed") && (
                            <span className="text-[10.5px] text-hint">{o.daysInStage}d in stage</span>
                          )}
                          {o.expectedCloseDate && (
                            <span className="text-[10.5px] text-hint">→ {o.expectedCloseDate}</span>
                          )}
                        </div>
                      </button>

                      {/* Stage move as a select rather than drag-and-drop:
                          keyboard-reachable, and it works on the phone an
                          advisor actually has in a client car park. */}
                      <select
                        value={o.stage}
                        disabled={busy === o.workItemId}
                        onChange={(e) => move(o, e.target.value as OpportunityStage)}
                        className="mt-2 w-full rounded-md border border-rule bg-warm/60 px-1.5 py-1 text-[11px] text-ink2 outline-none focus:border-brand-violet"
                      >
                        {ALL_STAGES.map((s) => (
                          <option key={s} value={s}>{humanise(s)}</option>
                        ))}
                      </select>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {(creating || editing) && (
        <OpportunityFormDialog
          accounts={accounts}
          initial={editing ?? undefined}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSubmit={onSubmit}
          busy={busy === "form"}
        />
      )}
    </>
  );
}

function OpportunityFormDialog({
  accounts, initial, onClose, onSubmit, busy,
}: {
  accounts: Account[]; initial?: Opportunity;
  onClose: () => void; onSubmit: (input: OpportunityInput) => void; busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [accountPartyId, setAccountPartyId] = useState(initial?.accountPartyId ?? accounts[0]?.partyId ?? "");
  const [opportunityType, setOpportunityType] = useState<OpportunityType | "">(initial?.opportunityType ?? "");
  const [stage, setStage] = useState<OpportunityStage>(initial?.stage ?? "qualification");
  const [value, setValue] = useState(initial?.value ?? "");
  const [probability, setProbability] = useState(initial?.probability?.toString() ?? "");
  const [expectedCloseDate, setExpectedCloseDate] = useState(initial?.expectedCloseDate ?? "");
  const [nextAction, setNextAction] = useState(initial?.nextAction ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");

  const closing = CLOSED_STAGES.includes(stage);

  return (
    <DialogShell
      title={initial ? (initial.name ?? initial.number) : "New opportunity"}
      wide
      subtitle="A corporate deal against an account. Separate from the B2C lead pipeline — this one has a company on the other side of it."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !accountPartyId) return;
          onSubmit({
            name: name.trim(),
            accountPartyId,
            opportunityType: opportunityType || null,
            stage,
            value: String(value).trim() || null,
            probability: probability.trim() ? Number(probability) : null,
            expectedCloseDate: expectedCloseDate || null,
            nextAction: nextAction.trim() || null,
            description: description.trim() || null,
          });
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="Opportunity name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Acme — Agentic AI cohort, Q3" />
          </Field>
          <Field label="Account" required>
            <select className={inputCls} value={accountPartyId} onChange={(e) => setAccountPartyId(e.target.value)}>
              {accounts.length === 0 && <option value="">— No accounts yet —</option>}
              {accounts.map((a) => <option key={a.partyId} value={a.partyId}>{a.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Field label="Type">
            <select className={inputCls} value={opportunityType} onChange={(e) => setOpportunityType(e.target.value as OpportunityType | "")}>
              <option value="">—</option>
              {TYPES.map((t) => <option key={t} value={t}>{humanise(t)}</option>)}
            </select>
          </Field>
          <Field
            label="Stage"
            hint={closing ? "The close date is set to today automatically." : undefined}
          >
            <select className={inputCls} value={stage} onChange={(e) => setStage(e.target.value as OpportunityStage)}>
              {ALL_STAGES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
          <Field label="Value (₹)">
            <input className={inputCls} value={value ?? ""} onChange={(e) => setValue(e.target.value)} inputMode="numeric" placeholder="e.g. 2500000" />
          </Field>
          <Field label="Probability %">
            <input className={inputCls} value={probability} onChange={(e) => setProbability(e.target.value)} inputMode="numeric" placeholder="0–100" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Expected close">
            <input type="date" className={inputCls} value={expectedCloseDate} onChange={(e) => setExpectedCloseDate(e.target.value)} />
          </Field>
          <Field label="Next action">
            <input className={inputCls} value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. Send revised SOW" />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            className={`${inputCls} min-h-[70px] resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
