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

// 'voice' (Exotel) and 'email' (Gmail) aren't Twilio at all — they reuse the
// tw_* tables and this union rather than duplicating the whole inbox stack.
export type TwChannel = "sms" | "whatsapp" | "voice" | "email";

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
 * Combine (phone_country_code, phone) into full E.164. Handles all four
 * storage shapes we've seen in the wild:
 *   (a) cc='+91', phone='9876543210'      → '+919876543210'
 *   (b) cc=null,  phone='+919876543210'    → '+919876543210'
 *   (c) cc=null,  phone='9876543210' (10d, Indian mobile-shape [6-9])
 *                                          → '+919876543210' (assumed India)
 *   (d) neither present or too short       → null
 *
 * The (c) fallback is India-specific because that's this CRM's operating
 * region — anything else falls through to null so callers can skip rather
 * than send a Twilio 63024 to garbage.
 *
 * Mirror of composeE164() in lib/campaigns/worker.ts and composePartyPhone()
 * in routes/twilio.ts — extracted here so writes into contact_point can
 * canonicalise before insert.
 */
export function composeFullE164(
  cc: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  const rawPhone = (phone ?? "").trim();
  if (!rawPhone) return null;
  const phoneDigits = rawPhone.replace(/\D/g, "");
  if (rawPhone.startsWith("+") && phoneDigits.length > 10) {
    return `+${phoneDigits}`;
  }
  const ccDigits = (cc ?? "").replace(/\D/g, "");
  if (ccDigits) return `+${ccDigits}${phoneDigits}`;
  if (phoneDigits.length === 10 && /^[6-9]/.test(phoneDigits)) {
    return `+91${phoneDigits}`;
  }
  return null;
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
