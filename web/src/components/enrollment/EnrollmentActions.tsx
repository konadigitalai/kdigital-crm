"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { verifyEnrollmentPayment, convertEnrollmentToLearner } from "@/lib/api";

// Payment verification + "Convert to Learner" controls for the enrollment
// record. Convert is HARD-blocked (server + client) until payment is verified;
// the button stays disabled with an explanatory tooltip until then.
export function EnrollmentActions({
  enrolmentId, partyId, paymentVerifiedAt, verifiedByName, isLearner,
}: {
  enrolmentId: string;
  partyId: string;
  paymentVerifiedAt: string | null;
  verifiedByName: string | null;
  isLearner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy]     = useState<null | "verify" | "convert">(null);
  const [error, setError]   = useState<string | null>(null);
  const verified = !!paymentVerifiedAt;

  async function verify() {
    if (busy || verified) return;
    setBusy("verify"); setError(null);
    try {
      await verifyEnrollmentPayment(enrolmentId);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function convert() {
    if (busy || !verified || isLearner) return;
    setBusy("convert"); setError(null);
    try {
      const result = await convertEnrollmentToLearner(enrolmentId);
      router.push(`/learners/${result.partyId}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="mb-6 rounded-[18px] border border-rule bg-paper">
      <div className="border-b border-rule p-5">
        <div className="mono-cap text-[10px] font-semibold tracking-[.14em] text-brand-violet">Conversion</div>
        <p className="mt-0.5 text-[13px] text-mute">
          Verify payment, then convert this enrolment into a learner.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {/* Payment verification */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold tracking-[-.005em]">Payment verification</div>
            <div className="mt-0.5 text-[12px] text-mute">
              {verified
                ? `Verified${verifiedByName ? ` by ${verifiedByName}` : ""} · ${fmtDate(paymentVerifiedAt)}`
                : "Not verified yet — finance must sign off before conversion."}
            </div>
          </div>
          {verified ? (
            <span className="mono-cap inline-flex items-center gap-1.5 rounded-full bg-[rgba(46,158,106,.10)] px-2.5 py-1 text-[10px] font-semibold text-state-ok">
              <Icon name="check" size={12} strokeWidth={2.4} />
              Verified
            </span>
          ) : (
            <button
              type="button"
              onClick={verify}
              disabled={busy !== null}
              className="btn disabled:opacity-50"
            >
              <Icon name="check" size={14} strokeWidth={2} />
              {busy === "verify" ? "Verifying…" : "Verify payment"}
            </button>
          )}
        </div>

        {/* Convert to learner */}
        <div className="flex items-center justify-between gap-4 border-t border-dashed border-rule pt-4">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold tracking-[-.005em]">Convert to Learner</div>
            <div className="mt-0.5 text-[12px] text-mute">
              {isLearner
                ? "Already converted to a learner."
                : verified
                  ? "Payment verified — ready to convert."
                  : "Verify payment first to unlock conversion."}
            </div>
          </div>
          {isLearner ? (
            <Link href={`/learners/${partyId}`} className="btn-grad">
              <Icon name="graduation-cap" size={14} strokeWidth={2} />
              Open learner
            </Link>
          ) : (
            <button
              type="button"
              onClick={convert}
              disabled={!verified || busy !== null}
              title={verified ? "Convert to learner" : "Verify payment before converting"}
              className={cn("btn-grad", (!verified || busy !== null) && "disabled:opacity-50")}
            >
              <Icon name="graduation-cap" size={14} strokeWidth={2} />
              {busy === "convert" ? "Converting…" : "Convert to Learner"}
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
