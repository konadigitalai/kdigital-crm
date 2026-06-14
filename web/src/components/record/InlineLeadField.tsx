"use client";

// Thin wrapper around InlineField that calls PATCH /leads/:n with whatever
// single field changed. Centralises the API binding so the record page
// doesn't repeat the try/catch + router.refresh dance for every cell.
//
// Server-component-safe: every prop here is plain data (no functions),
// so the wrapper can be passed from the lead record server component.

import { useRouter } from "next/navigation";
import { InlineField, type IdleStyle, type InlineFieldKind } from "@/components/inline/InlineField";
import { updateLead } from "@/lib/api";

export interface InlineLeadFieldProps {
  leadNumber: string;
  /** Field name on the leads PATCH body. */
  field: string;
  kind: InlineFieldKind;
  ariaLabel: string;
  /** Idle-mode rendering style (mailto / phone / url / select-label / default). */
  idleStyle?: IdleStyle;
  className?: string;
  valueClass?: string;
  required?: boolean;
  /**
   * Optional sibling-field map. When the user picks `key`, the patch also
   * carries the corresponding additional fields. Used for things like Source
   * where we persist both the canonical key and the human label in one PATCH.
   */
  extraByValue?: Record<string, Record<string, unknown>>;
  /** If true, the field renders as static text — no edit affordance. */
  readOnly?: boolean;
}

export function InlineLeadField({
  leadNumber,
  field,
  kind,
  ariaLabel,
  idleStyle,
  className,
  valueClass,
  required,
  extraByValue,
  readOnly,
}: InlineLeadFieldProps) {
  const router = useRouter();
  return (
    <InlineField
      kind={kind}
      ariaLabel={ariaLabel}
      idleStyle={idleStyle}
      className={className}
      valueClass={valueClass}
      required={required}
      readOnly={readOnly}
      onSave={async (next) => {
        const patch: Record<string, unknown> = { [field]: next };
        if (extraByValue && next != null) {
          const extra = extraByValue[String(next)];
          if (extra) Object.assign(patch, extra);
        }
        await updateLead(leadNumber, patch);
        router.refresh();
      }}
    />
  );
}
