"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { convertLead, getCatalog } from "@/lib/api";
import type { CatalogResponse } from "@/lib/types";

export function ConvertButton({ leadNumber, leadName, programId }: {
  leadNumber: string; leadName: string; programId: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="btn-grad">
        <Icon name="check" size={14} strokeWidth={2.2} /> Convert to learner
      </button>
      {open && (
        <ConvertDialog
          leadNumber={leadNumber}
          leadName={leadName}
          programId={programId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ConvertDialog({ leadNumber, leadName, programId, onClose }: {
  leadNumber: string; leadName: string; programId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [pickedProgramId, setPickedProgramId] = useState<string>(programId ?? "");
  const [pricePaid, setPricePaid] = useState<string>("");
  const [busy, setBusy]       = useState(false);

  useEffect(() => {
    getCatalog()
      .then((c) => {
        setCatalog(c);
        if (!pickedProgramId && c.programs[0]) setPickedProgramId(c.programs[0].id);
      })
      .catch((e) => setError((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When program changes, default the price to the program's price
  useEffect(() => {
    if (!catalog) return;
    const p = catalog.programs.find((p) => p.id === pickedProgramId);
    if (p && p.price && !pricePaid) setPricePaid(p.price);
  }, [pickedProgramId, catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickedProgram = catalog?.programs.find((p) => p.id === pickedProgramId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pickedProgramId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await convertLead(leadNumber, {
        programId: pickedProgramId,
        pricePaid: pricePaid || undefined,
      });
      router.push(`/learners/${result.partyId}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">
              Convert {leadName} to a learner
            </h2>
            <p className="mt-1 text-[13px] leading-[1.5] text-mute">
              Confirms the program and creates an enrolment. Batches across courses are assigned next, on the learner record page.
            </p>
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Program">
            <select
              value={pickedProgramId}
              onChange={(e) => { setPickedProgramId(e.target.value); setPricePaid(""); }}
              className={inputCls}
              disabled={!catalog}
            >
              {catalog?.programs.length === 0 && <option value="">— no programs available —</option>}
              {catalog?.programs.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.price ? ` · ₹${Number(p.price).toLocaleString("en-IN")}` : ""}</option>
              ))}
            </select>
          </Field>

          <Field label={`Price paid (₹)${pickedProgram?.price ? ` — list price ₹${Number(pickedProgram.price).toLocaleString("en-IN")}` : ""}`}>
            <input
              value={pricePaid}
              onChange={(e) => setPricePaid(e.target.value)}
              placeholder={pickedProgram?.price ?? "e.g. 119000"}
              className={inputCls}
            />
          </Field>

          {error && (
            <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn">Cancel</button>
            <button
              type="submit"
              disabled={busy || !pickedProgramId}
              className="btn-grad disabled:opacity-60"
            >
              {busy ? "Converting…" : "Convert & enrol"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:bg-warm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      {children}
    </label>
  );
}
