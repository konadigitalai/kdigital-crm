"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { patchLearnerFee } from "@/lib/api";
import type { LearnerFeeInput, PaymentStatus } from "@/lib/types";

// Fee ledger — single per learner. Layout is two columns:
//   Left  — fee amounts (quoted, paid, computed due)
//   Right — payment details (due date, status, multiple proof images, notes)
// feeDue is derived (quoted − paid) so it never disagrees with the inputs.
// Save emits an activity row via the API so the timeline records the diff.

const STATUSES: { value: PaymentStatus; label: string; cls: string }[] = [
  { value: "pending", label: "Pending",  cls: "bg-[rgba(224,138,30,.12)] text-state-amber" },
  { value: "paid",    label: "Paid",     cls: "bg-[rgba(46,158,106,.10)] text-state-ok" },
  { value: "refund",  label: "Refund",   cls: "bg-[rgba(217,83,79,.10)]  text-state-warn" },
  { value: "on_hold", label: "On hold",  cls: "bg-warm2                  text-mute" },
];

// Cap uploaded receipts. 3 MB source → ~4 MB as base64. The API rejects
// anything past ~5 MB per file and ~20 MB total; we stop earlier so the user
// gets a clearer error client-side.
const MAX_PROOF_SOURCE_BYTES = 3 * 1024 * 1024;
const MAX_PROOFS_TOTAL_BYTES = 18 * 1024 * 1024;

export interface FeeLedgerValue {
  feeQuoted:     string | null;
  feePaid:       string | null;
  dueDate:       string | null;
  paymentStatus: PaymentStatus | null;
  paymentProofs: string[];
  feeNotes:      string | null;
}

export function FeeLedgerCard({ partyId, initial, saveFee }: {
  partyId: string;
  initial: FeeLedgerValue;
  // Where the ledger saves to. Defaults to the learner fee route
  // (patchLearnerFee). The enrollment record passes its own saver so the same
  // card can target the enrolment fee route by id/number instead.
  saveFee?: (patch: LearnerFeeInput) => Promise<void>;
}) {
  const router = useRouter();
  const [feeQuoted, setFeeQuoted] = useState(initial.feeQuoted   ?? "");
  const [feePaid,   setFeePaid]   = useState(initial.feePaid     ?? "");
  const [dueDate,   setDueDate]   = useState(initial.dueDate     ?? "");
  const [status,    setStatus]    = useState<PaymentStatus | "">(initial.paymentStatus ?? "");
  const [proofs,    setProofs]    = useState<string[]>(initial.paymentProofs ?? []);
  const [feeNotes,  setFeeNotes]  = useState(initial.feeNotes    ?? "");
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const feeDue = computeDue(feeQuoted, feePaid);
  const dirty =
       (feeQuoted || null) !== (initial.feeQuoted   ?? null)
    || (feePaid   || null) !== (initial.feePaid     ?? null)
    || (dueDate   || null) !== (initial.dueDate     ?? null)
    || (status    || null) !== (initial.paymentStatus ?? null)
    || !proofsEqual(proofs, initial.paymentProofs ?? [])
    || (feeNotes  || null) !== (initial.feeNotes    ?? null);

  async function save() {
    if (!dirty || busy) return;
    setBusy(true); setError(null); setNotice(null);
    const patch: LearnerFeeInput = {
      feeQuoted:     normaliseMoney(feeQuoted),
      feePaid:       normaliseMoney(feePaid),
      dueDate:       dueDate || null,
      paymentStatus: status  || null,
      paymentProofs: proofs,
      feeNotes:      feeNotes.trim() || null,
    };
    try {
      await (saveFee ? saveFee(patch) : patchLearnerFee(partyId, patch));
      setNotice("Saved");
      router.refresh();
      setTimeout(() => setNotice(null), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-[18px] border border-rule bg-paper">
      <div className="flex items-center justify-between border-b border-rule p-5">
        <div>
          <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Fee ledger</div>
          <p className="mt-0.5 text-[13px] text-mute">Quoted, paid, and due at a glance. Edits are recorded on the timeline.</p>
        </div>
        <div className="flex items-center gap-2">
          {notice && (
            <span className="mono-cap rounded-full bg-[rgba(46,158,106,.10)] px-2 py-0.5 text-[9.5px] font-semibold text-state-ok">
              {notice}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            className="btn-grad disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 p-5 md:grid-cols-2">
        {/* Left column — fee amounts */}
        <div className="space-y-4">
          <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-mute">Amounts</div>
          <MoneyField label="Fee quoted (₹)" value={feeQuoted} onChange={setFeeQuoted} />
          <MoneyField label="Fee paid (₹)"   value={feePaid}   onChange={setFeePaid} />
          <ReadOnlyField
            label="Fee due (₹)"
            value={feeDue == null ? "—" : `₹${feeDue.toLocaleString("en-IN")}`}
            hint="Auto-computed: quoted − paid."
          />
        </div>

        {/* Right column — payment details */}
        <div className="space-y-4">
          <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-mute">Payment</div>
          <DateField label="Due date" value={dueDate} onChange={setDueDate} />
          <StatusField label="Payment status" value={status} onChange={setStatus} />
          <ProofsField
            label="Payment proofs"
            values={proofs}
            onChange={setProofs}
            onError={setError}
          />
          <TextAreaField
            label="Fee notes"
            value={feeNotes}
            onChange={setFeeNotes}
            placeholder="Anything the payment status doesn't capture — EMI plan, waiver, chargeback in flight, etc."
          />
        </div>
      </div>

      {error && (
        <div className="mx-5 mb-5 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}
    </div>
  );
}

function computeDue(quoted: string, paid: string): number | null {
  const q = Number(quoted);
  const p = Number(paid || "0");
  if (!Number.isFinite(q)) return null;
  const due = q - (Number.isFinite(p) ? p : 0);
  return due < 0 ? 0 : due;
}

function normaliseMoney(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : null;
}

function proofsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function MoneyField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        placeholder="0"
        className={inputCls}
      />
    </label>
  );
}

function ReadOnlyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      <div className={cn(inputCls, "bg-warm/40 font-mono text-ink")}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-mute">{hint}</div>}
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={inputCls} />
    </label>
  );
}

function StatusField({ label, value, onChange }: {
  label: string;
  value: PaymentStatus | "";
  onChange: (v: PaymentStatus | "") => void;
}) {
  return (
    <div className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => {
          const on = value === s.value;
          return (
            <button
              type="button"
              key={s.value}
              onClick={() => onChange(on ? "" : s.value)}
              className={cn(
                "mono-cap rounded-full px-2.5 py-1 text-[10px] font-semibold transition",
                on
                  ? cn(s.cls, "ring-1 ring-inset ring-current")
                  : "border border-rule bg-paper text-ink2 hover:border-rule2",
              )}
              title={on ? "Click again to clear" : `Set to ${s.label}`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Multi-image receipt uploader. Each entry is either an https URL (rare —
// legacy pasted links) or a data: URL from FileReader. The layout is a
// wrapping grid of thumbnails; clicking one opens the receipt full-size in
// a new tab, hovering exposes a Remove control.
function ProofsField({ label, values, onChange, onError }: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  onError: (msg: string | null) => void;
}) {
  const totalBytes = values.reduce((n, v) => n + v.length, 0);

  function addFiles(files: FileList | File[]) {
    onError(null);
    const picked = Array.from(files);
    if (picked.length === 0) return;

    const next: string[] = [];
    let running = totalBytes;

    (async () => {
      for (const file of picked) {
        if (!file.type.startsWith("image/")) {
          onError("Only image files are supported for payment receipts.");
          return;
        }
        if (file.size > MAX_PROOF_SOURCE_BYTES) {
          onError(`"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum per file is 3 MB.`);
          return;
        }
        // Rough guard — base64 grows ~33%. Stop before the API's total cap.
        if (running + file.size * 1.4 > MAX_PROOFS_TOTAL_BYTES) {
          onError("Combined receipt size is too large. Remove one before adding another.");
          return;
        }
        const dataUrl = await readAsDataUrl(file);
        running += dataUrl.length;
        next.push(dataUrl);
      }
      onChange([...values, ...next]);
    })().catch((err: unknown) => onError((err as Error).message));
  }

  function removeAt(idx: number) {
    onChange(values.filter((_, i) => i !== idx));
  }

  function openAt(idx: number) {
    const v = values[idx];
    if (!v) return;
    if (/^https?:\/\//i.test(v)) {
      window.open(v, "_blank", "noopener,noreferrer");
      return;
    }
    // data: URL — synthesise a blob URL so Firefox (which blocks top-level
    // data: navigation) can open it too.
    try {
      const [meta, b64] = v.split(",");
      const mime = /data:([^;,]+)/.exec(meta ?? "")?.[1] ?? "application/octet-stream";
      const bin = atob(b64 ?? "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      window.open(blobUrl, "_blank", "noopener,noreferrer");
    } catch {
      onError("Could not open receipt.");
    }
  }

  return (
    <div className="block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="mono-cap block text-[10px] font-semibold tracking-[.12em] text-mute">
          {label}{values.length > 0 && ` · ${values.length}`}
        </span>
      </div>

      {values.length > 0 && (
        <div className="mb-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {values.map((v, i) => (
            <div
              key={`${i}-${v.slice(0, 32)}`}
              className="group relative aspect-square overflow-hidden rounded-md ring-1 ring-inset ring-rule hover:ring-brand-violet"
            >
              <button
                type="button"
                onClick={() => openAt(i)}
                title="Open receipt in a new tab"
                className="block h-full w-full"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={v}
                  alt={`Payment proof ${i + 1}`}
                  className="h-full w-full object-cover"
                />
                <span className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wider text-white opacity-0 transition group-hover:opacity-100">
                  Open
                </span>
              </button>
              <button
                type="button"
                onClick={() => removeAt(i)}
                title="Remove"
                aria-label={`Remove receipt ${i + 1}`}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition hover:bg-state-warn group-hover:opacity-100"
              >
                <Icon name="plus" size={12} strokeWidth={2.4} className="rotate-45" />
              </button>
            </div>
          ))}
        </div>
      )}

      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed border-rule bg-warm/20 px-3 py-3 text-[12.5px] text-mute hover:border-brand-violet hover:text-brand-violet">
        <Icon name="plus" size={14} strokeWidth={2} />
        <span>{values.length === 0 ? "Upload receipt images" : "Add more receipts"}</span>
        <input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const f = e.target.files;
            if (f && f.length > 0) addFiles(f);
            // Reset so picking the same file twice re-fires onChange.
            e.currentTarget.value = "";
          }}
        />
      </label>
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === "string") resolve(r);
      else reject(new Error(`Could not read "${file.name}".`));
    };
    reader.readAsDataURL(file);
  });
}

function TextAreaField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className={cn(inputCls, "min-h-[72px] resize-y")}
      />
    </label>
  );
}

const inputCls = "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";
