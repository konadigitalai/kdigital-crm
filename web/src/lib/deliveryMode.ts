// Delivery mode, in one place.
//
// There is one vocabulary: online | classroom | hybrid.
//
// It took a correction to get here. post-0024 originally called the middle
// value 'offline'; post-0060 renamed it to 'classroom' across `lead` because
// "'Offline' was a misleading label"; post-0088 then reintroduced 'offline'
// on enrolment and cohort by copying the stale comment, and post-0093 undid
// that. The upshot is worth stating plainly so nobody re-derives it: the CRM
// and the KDigital registry use the SAME three values, and the registry's
// (Online | Classroom | Hybrid) differ only in case.
//
// So this module is a case-folding layer and a label helper, not a
// translation table. If a genuinely different vocabulary ever appears, this
// is still the only file that has to learn about it.

/** What the CRM stores. Identical to the registry's set, lower case. */
export type DeliveryMode = "online" | "classroom" | "hybrid";

export const DELIVERY_MODES: DeliveryMode[] = ["online", "classroom", "hybrid"];

const VALID = new Set<string>(DELIVERY_MODES);

/** Title-case for display. */
export function deliveryModeLabel(mode: string | null | undefined): string {
  if (!mode) return "—";
  const key = mode.trim().toLowerCase();
  if (!key) return "—";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Normalise anything — a registry string, a form value, a legacy 'offline'
 *  row — to the CRM value. Unknown input returns null rather than guessing,
 *  so an unrecognised vocabulary surfaces as a visible gap instead of being
 *  silently coerced to 'online'. */
export function normaliseDeliveryMode(mode: string | null | undefined): DeliveryMode | null {
  if (!mode) return null;
  const key = mode.trim().toLowerCase();
  // Pre-post-0060 data and any import still carrying the old spelling.
  if (key === "offline") return "classroom";
  return VALID.has(key) ? (key as DeliveryMode) : null;
}

/** The registry publishes title case; `program.deliveryModes` stores it
 *  verbatim because CAT-010 forbids rewording an approved record. */
export function toRegistryDeliveryMode(mode: DeliveryMode): string {
  return deliveryModeLabel(mode);
}

/** Is this mode one the programme is published for?
 *
 *  An empty or absent list means "not stated", which is permissive on
 *  purpose — a programme with no declared modes should not become
 *  unsellable because the registry left the column blank. */
export function programmeAllowsDeliveryMode(
  programmeDeliveryModes: string[] | null | undefined,
  mode: DeliveryMode | null | undefined,
): boolean {
  if (!mode) return true;
  if (!programmeDeliveryModes || programmeDeliveryModes.length === 0) return true;
  return programmeDeliveryModes.some((m) => normaliseDeliveryMode(m) === mode);
}
