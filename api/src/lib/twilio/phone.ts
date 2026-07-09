// Phone-number normalisation and Twilio address parsing.
//
// Twilio addresses come in two forms:
//   - SMS:      "+15551234567"           (E.164)
//   - WhatsApp: "whatsapp:+15551234567"  (E.164 with a channel prefix)
//
// Rather than sprinkle prefix-handling all over the routes, everything goes
// through `parseTwilioAddr` on the way in and `formatTwilioAddr` on the way
// out. That way `contact_point.value` always stores plain E.164 regardless
// of channel, matching how the rest of the CRM stores phone numbers.

export type TwChannel = "sms" | "whatsapp";

/** Strip non-digit characters. Handy for comparing phones with mixed formats. */
export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Render an E.164 number with a leading '+'. Accepts input with or without one. */
export function toE164(phone: string | null | undefined): string {
  const d = digitsOnly(phone);
  return d.length ? `+${d}` : "";
}

/**
 * Parse a Twilio-style address into channel + E.164 pair.
 * Examples:
 *   "whatsapp:+919876543210" → { channel: "whatsapp", e164: "+919876543210" }
 *   "+15551234567"          → { channel: "sms",      e164: "+15551234567"  }
 * Empty/invalid input returns null.
 */
export function parseTwilioAddr(addr: string | null | undefined): {
  channel: TwChannel;
  e164: string;
} | null {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!s) return null;
  if (s.startsWith("whatsapp:")) {
    const e164 = toE164(s.slice("whatsapp:".length));
    return e164 ? { channel: "whatsapp", e164 } : null;
  }
  const e164 = toE164(s);
  return e164 ? { channel: "sms", e164 } : null;
}

/**
 * Render a phone for sending via Twilio, adding the channel prefix as needed.
 *   ("sms",      "+15551234567") → "+15551234567"
 *   ("whatsapp", "+15551234567") → "whatsapp:+15551234567"
 */
export function formatTwilioAddr(channel: TwChannel, e164: string): string {
  const n = toE164(e164);
  if (!n) return "";
  return channel === "whatsapp" ? `whatsapp:${n}` : n;
}
