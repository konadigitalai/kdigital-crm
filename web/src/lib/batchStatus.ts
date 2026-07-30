// Cohort ("batch") status — one definition, read by every surface that shows it.
//
// This palette was copy-pasted into eight files: the batches board, list,
// kanban and detail, the admin batches table, the learner record page, and
// both LMS screens. They had already drifted — the Academy screens rendered
// their own colours and lowercase labels while the CRM showed styled pills,
// which is what prompted this. Same reasoning as navItems.ts: if two panels
// must agree, they read from one list.
//
// Values match the cohort_status_check constraint in the database:
//   CHECK (status IN ('upcoming','running','completed','cancelled'))

export const BATCH_STATUSES = ["upcoming", "running", "completed", "cancelled"] as const;
export type BatchStatusValue = (typeof BATCH_STATUSES)[number];

export const BATCH_STATUS_CLS: Record<string, string> = {
  upcoming:  "bg-[rgba(31,63,207,.08)]  text-brand-blue",
  running:   "bg-[rgba(46,158,106,.10)] text-state-ok",
  completed: "bg-warm2                  text-mute",
  cancelled: "bg-[rgba(217,83,79,.10)]  text-state-warn",
};

export const BATCH_STATUS_LABEL: Record<string, string> = {
  upcoming:  "Upcoming",
  running:   "Running",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const BATCH_STATUS_OPTIONS = BATCH_STATUSES.map((value) => ({
  value,
  label: BATCH_STATUS_LABEL[value]!,
  cls: BATCH_STATUS_CLS[value]!,
}));

/** Fallback keeps an unexpected value visible rather than unstyled — if the
 *  database ever grows a status the UI doesn't know, it still renders. */
export function batchStatusCls(status: string | null | undefined): string {
  return BATCH_STATUS_CLS[status ?? ""] ?? "bg-warm2 text-mute";
}

export function batchStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return BATCH_STATUS_LABEL[status] ?? status;
}

/** The pill className used across the CRM. Kept here so the Academy screens
 *  can't drift on padding or weight either. */
export const BATCH_STATUS_PILL =
  "mono-cap inline-flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-semibold";
