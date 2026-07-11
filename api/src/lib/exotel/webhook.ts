// Exotel webhook parsing.
//
// Exotel does not sign webhooks — no HMAC, no X-Signature header. The docs
// only say "your endpoint should respond with HTTP 200 to acknowledge
// receipt." So we defend by:
//   1. Requiring the request come from an EXOTEL_ALLOWED_IPS entry (optional).
//   2. Routing via a path-segment shared secret (owned by the route file).
//   3. Never trusting the payload for anything security-relevant — the
//      party lookup goes through matchOrCreatePartyByPhone which won't
//      match an arbitrary attacker-controlled E.164 to a random party.
//
// Two shapes to parse:
//
//   a) StatusCallback (outbound Connect API call completed):
//      Content-Type application/json OR application/x-www-form-urlencoded
//      depending on what we set on the call. We set JSON.
//      Fields: CallSid, EventType, Status, From, To, PhoneNumberSid,
//              StartTime, EndTime, ConversationDuration, Direction,
//              RecordingUrl, CustomField, Legs[]
//
//   b) Passthru (inbound ExoPhone call — configured in Exotel dashboard):
//      Form-encoded. Fields: CallSid, CallFrom, CallTo, Direction,
//      DialCallStatus, DialCallDuration, StartTime, RecordingUrl, ...
//      Docs don't fully enumerate — we read what's known and stash the
//      full body in `raw` so we can widen later.


export type ExotelParsedKind =
  | "answered"          // outbound: agent picked up
  | "terminal"          // outbound: call ended (any status)
  | "inbound_missed";   // inbound: customer called our ExoPhone

export interface ExotelParsedCall {
  kind:              ExotelParsedKind;
  callSid:           string;
  /** Direction as Exotel reports it. `outbound-api`, `inbound`, etc. */
  direction:         string | null;
  fromE164:          string | null;
  toE164:            string | null;
  status:            string | null;  // "completed" | "no-answer" | "busy" | "failed" | ...
  durationSeconds:   number | null;
  recordingUrl:      string | null;
  customField:       string | null;
  legs:              unknown | null;
  raw:               Record<string, unknown>;
}

export type ExotelParsedResult = ExotelParsedCall | { kind: "ignore" };

/**
 * Normalize any form-encoded string to a Record<string, unknown> — Express
 * already parses application/x-www-form-urlencoded into an object via
 * `express.urlencoded()`, so this is mostly a type-guard. For JSON bodies
 * Express hands us the parsed object directly; both paths work.
 */
export function coerceFormBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function s(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t || null;
}
function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

/** Normalize Exotel's phone shapes to E.164. Exotel Passthru webhooks
 *  ship Indian numbers as "07032770627" (leading 0, no country code) or
 *  sometimes "0919963039919" (leading 0 + country code). Sometimes an
 *  already-E.164 "+919…" arrives. Handle all three so downstream party
 *  matching gets a canonical +91… string.
 *
 *  Rules (India-first, since this is an Indian account):
 *   - Already starts with '+': trust it, just strip non-digits after.
 *   - Starts with '0' followed by 12 digits (0 + 91 + 10-digit mobile):
 *     drop the leading '0' → +91… .
 *   - Starts with '0' followed by 10 digits (0 + local subscriber):
 *     drop the leading '0' and prefix +91 → +91…10.
 *   - 10 digits, first is 6-9 (Indian mobile shape): prefix +91.
 *   - Anything else: fall back to bare toE164 (may still be wrong, but
 *     matchOrCreatePartyByPhone will fall through and log nothing rather
 *     than corrupt data).
 */
function normalizeExotelPhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const d = trimmed.replace(/\D/g, "");
    return d ? `+${d}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  // 0 + 91 + 10 = 13 digits, starting with '091' after strip → +91…
  if (digits.length === 13 && digits.startsWith("091")) return `+${digits.slice(1)}`;
  // 0 + 10 digits → assume India, drop leading 0, prefix +91
  if (digits.length === 11 && digits.startsWith("0") && /^[6-9]/.test(digits[1] ?? "")) {
    return `+91${digits.slice(1)}`;
  }
  // 10 digits, Indian-mobile-shape starts 6-9 → +91
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  // Fallback: assume it's already-E.164-ish digits, just prefix +
  return `+${digits}`;
}

/** Parse either a StatusCallback (outbound) or a Passthru (inbound). The
 *  distinguishing field is `EventType` (present on StatusCallback) vs
 *  `CallFrom`/`CallTo` (present on Passthru). */
export function parseExotelCallback(body: unknown): ExotelParsedResult {
  const b = coerceFormBody(body);

  // StatusCallback (outbound-api) uses `EventType`. Exotel v1 docs show
  // 'terminal' / 'answered', but the actual Passthru at the applet level
  // also fires a 'Terminal' event with the same fields plus DialWhomNumber
  // and RecordingAvailableBy — treat both flavours as terminal.
  const eventTypeRaw = s(b.EventType);
  const eventTypeLc  = eventTypeRaw?.toLowerCase() ?? null;
  const callSid   = s(b.CallSid);
  if (eventTypeLc && callSid) {
    const kind: ExotelParsedKind = eventTypeLc === "answered" ? "answered" : "terminal";
    return {
      kind,
      callSid,
      direction:       s(b.Direction),
      fromE164:        normalizeExotelPhone(s(b.From ?? b.CallFrom)),
      toE164:          normalizeExotelPhone(s(b.To   ?? b.CallTo)),
      status:          s(b.Status ?? b.DialCallStatus),
      durationSeconds: n(b.ConversationDuration ?? b.DialCallDuration),
      recordingUrl:    s(b.RecordingUrl),
      customField:     s(b.CustomField),
      legs:            b.Legs ?? null,
      raw:             b,
    };
  }

  // Passthru (inbound) — no EventType. Fields: CallFrom, CallTo,
  // DialCallStatus, DialCallDuration, sometimes RecordingUrl.
  const callFrom = s(b.CallFrom ?? b.From);
  const callTo   = s(b.CallTo   ?? b.To);
  if (callSid && (callFrom || callTo)) {
    return {
      kind:            "inbound_missed",
      callSid,
      direction:       s(b.Direction) ?? "inbound",
      fromE164:        normalizeExotelPhone(callFrom),
      toE164:          normalizeExotelPhone(callTo),
      status:          s(b.DialCallStatus ?? b.Status),
      durationSeconds: n(b.DialCallDuration ?? b.ConversationDuration),
      recordingUrl:    s(b.RecordingUrl),
      customField:     s(b.CustomField),
      legs:            b.Legs ?? null,
      raw:             b,
    };
  }

  return { kind: "ignore" };
}

/** Check the client IP against a comma-separated CIDR-or-address allowlist.
 *  Empty allowlist = allow all (useful in dev). */
export function isIpAllowed(clientIp: string, allowlist: string): boolean {
  const list = allowlist.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
  // Simple exact-match on individual addresses — CIDR support is a v2
  // exercise if needed. Ops can list every Exotel egress IP explicitly.
  const c = clientIp.trim();
  return list.some((entry) => entry === c);
}
