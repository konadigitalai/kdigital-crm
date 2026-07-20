"use client";

import { FeeLedgerCard, type FeeLedgerValue } from "@/components/learner/FeeLedgerCard";
import { patchEnrollmentFee } from "@/lib/api";
import type { LearnerFeeInput } from "@/lib/types";

// Thin client wrapper so the (server-rendered) enrollment record page can reuse
// the learner FeeLedgerCard while pointing its save at the enrolment fee route
// (by enrolment id) instead of the learner fee route.
export function EnrollmentFeeLedger({ enrolmentId, initial }: {
  enrolmentId: string;
  initial: FeeLedgerValue;
}) {
  return (
    <FeeLedgerCard
      partyId={enrolmentId}
      initial={initial}
      saveFee={(patch: LearnerFeeInput) => patchEnrollmentFee(enrolmentId, patch).then(() => undefined)}
    />
  );
}
