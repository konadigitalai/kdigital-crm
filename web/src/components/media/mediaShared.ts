// Small shared helpers used across AttachmentPicker + StagedStrip +
// MessageMediaGallery. All pure, no server dependencies.

import type { TwChannel } from "@/lib/types";

/** Mirror of api/src/lib/twilio/media.ts humanBytes. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Kept in sync with api/src/lib/twilio/media.ts. WhatsApp Business API
// only accepts a strict MIME allowlist — anything outside fails with 63005.
const WHATSAPP_ALLOWED_MIMES = new Set<string>([
  "image/jpeg", "image/png",
  "video/mp4", "video/3gpp",
  "audio/aac", "audio/mp4", "audio/amr", "audio/mpeg", "audio/ogg",
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);
const SMS_ALLOWED_MIMES = new Set<string>([
  "image/jpeg", "image/png", "image/gif",
]);

/** Mirror of api/src/lib/twilio/media.ts validateMediaForChannel — client-side
 *  copy so we can block the send before hitting the API. */
export function validateMediaForChannel(
  channel: TwChannel,
  contentType: string,
  sizeBytes: number,
): { ok: true } | { ok: false; reason: string } {
  const mime = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const allowlist = channel === "whatsapp" ? WHATSAPP_ALLOWED_MIMES : SMS_ALLOWED_MIMES;
  if (!allowlist.has(mime)) {
    return {
      ok: false,
      reason: channel === "whatsapp"
        ? `WhatsApp doesn't support ${mime || contentType} — convert to PDF or an image and try again.`
        : `SMS/MMS only supports images (JPG/PNG/GIF). Try WhatsApp for other file types.`,
    };
  }
  const fam = familyFromMime(contentType);
  const cap = CAPS[channel][fam];
  if (!cap) {
    return { ok: false, reason: `${contentType} is not supported on ${channel}.` };
  }
  if (sizeBytes > cap.bytes) {
    return {
      ok: false,
      reason: `File is ${humanBytes(sizeBytes)} — ${channel === "whatsapp" ? "WhatsApp" : "SMS"} cap for ${fam} is ${cap.label}.`,
    };
  }
  return { ok: true };
}

export type MimeFamily = "image" | "video" | "audio" | "document" | "archive" | "other";

export function familyFromMime(mime: string): MimeFamily {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (
    m === "application/pdf" ||
    m.startsWith("application/msword") ||
    m.startsWith("application/vnd.openxmlformats-officedocument") ||
    m === "application/vnd.ms-excel" ||
    m === "application/vnd.ms-powerpoint" ||
    m === "text/plain" ||
    m === "text/csv" ||
    m === "application/rtf"
  ) return "document";
  if (
    m === "application/zip" ||
    m === "application/x-zip-compressed" ||
    m === "application/x-rar-compressed" ||
    m === "application/x-7z-compressed" ||
    m === "application/gzip" ||
    m === "application/x-tar"
  ) return "archive";
  return "other";
}

const MB = 1024 * 1024;
const CAPS: Record<TwChannel, Partial<Record<MimeFamily, { bytes: number; label: string }>>> = {
  whatsapp: {
    image:    { bytes: 5  * MB,  label: "5 MB" },
    video:    { bytes: 16 * MB,  label: "16 MB" },
    audio:    { bytes: 16 * MB,  label: "16 MB" },
    document: { bytes: 100 * MB, label: "100 MB" },
  },
  sms: {
    image:    { bytes: 5 * MB, label: "5 MB" },
  },
};

/** Icon glyph for each MIME family (Lucide-style Icon names our Icon component knows). */
export function iconForFamily(fam: MimeFamily): string {
  switch (fam) {
    case "image":    return "star";      // TODO: swap to an image icon if available
    case "video":    return "star";
    case "audio":    return "star";
    case "document": return "doc";
    case "archive":  return "doc";
    default:         return "doc";
  }
}
