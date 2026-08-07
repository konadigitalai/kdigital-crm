// Campaign variable resolver.
//
// Each campaign stores `content_variable_bindings` — a map from Twilio
// template placeholder (e.g. "1" or "first_name") to a *rule*. A rule is
// either:
//
//   - A literal string:  "Hello"
//   - A field path:      "{{party.name}}", "{{lead.program}}"
//
// This module resolves those rules to per-recipient values against a
// context we assembled from the audience-materialization SELECT.
//
// We deliberately do NOT hit the DB again per recipient — the campaign
// worker fetches everything it needs in one batch query and hands us the
// context object.

export interface RecipientContext {
  party: {
    id:     string;
    name:   string | null;
    phone:  string | null;
    email:  string | null;
    city:   string | null;
  };
  lead: {
    workItemId: string;
    number:     string;
    program:    string | null;
    stage:      string | null;
  };
}

/** Format matches `{{a.b}}` — captures the raw path. */
const PATH_RE = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

/** Read `a.b` off a nested object. Returns "" if any hop is missing. */
function readPath(ctx: RecipientContext, path: string): string {
  const parts = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return "";
    cur = cur[p];
  }
  if (cur == null) return "";
  return String(cur);
}

/** Resolve one binding against a context. Literals pass through; template
 *  paths are looked up. Empty/missing values become "" — the caller may
 *  choose to reject the recipient in that case. */
export function resolveBinding(binding: string, ctx: RecipientContext): string {
  const m = PATH_RE.exec(binding.trim());
  if (!m || !m[1]) return binding;
  return readPath(ctx, m[1]);
}

/** Resolve the whole bindings map. Keys are template placeholders; the
 *  Twilio API accepts both named ("first_name") and positional ("1"). */
export function resolveBindings(
  bindings: Record<string, string>,
  ctx: RecipientContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bindings ?? {})) {
    out[k] = resolveBinding(String(v ?? ""), ctx);
  }
  return out;
}

/** Return placeholders whose resolved value is empty — the campaign worker
 *  uses this to skip a recipient with a helpful error instead of sending
 *  a template with a blank placeholder. */
export function missingBindings(
  resolved: Record<string, string>,
): string[] {
  return Object.entries(resolved)
    .filter(([, v]) => v == null || String(v).trim() === "")
    .map(([k]) => k);
}
