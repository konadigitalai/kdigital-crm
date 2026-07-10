// Per-channel media type + size caps for Twilio.
//
// Source: Twilio docs
//   https://www.twilio.com/docs/messaging/guides/accepted-mime-types
//   https://www.twilio.com/docs/whatsapp/faq
//
// We enforce these BOTH client-side (helpful pre-submit error) AND
// server-side (defense in depth — a malicious client can bypass the FE).

import type { TwChannel } from "./phone.js";

/** Human-readable size cap per channel + MIME family. */
export interface MediaCap {
  bytes: number;
  label: string;   // "16 MB" etc — for error messages
}

// A "MIME family" is the coarse grouping we use to look up size caps.
export type MimeFamily =
  | "image"
  | "video"
  | "audio"
  | "document"    // PDF, doc, docx, ppt, pptx, xls, xlsx, csv, txt, rtf
  | "archive"    // zip, rar, 7z, gzip, tar
  | "other";

function familyFromMime(mime: string): MimeFamily {
  const m = mime.toLowerCase();
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

// WhatsApp: 5MB image; 16MB audio/video/gif; 100MB doc.
// SMS/MMS: 5MB image; other types varies by carrier — reject non-image.
const CAPS: Record<TwChannel, Partial<Record<MimeFamily, MediaCap>>> = {
  whatsapp: {
    image:    { bytes: 5  * MB,  label: "5 MB" },
    video:    { bytes: 16 * MB,  label: "16 MB" },
    audio:    { bytes: 16 * MB,  label: "16 MB" },
    document: { bytes: 100 * MB, label: "100 MB" },
    archive:  { bytes: 100 * MB, label: "100 MB" },
    other:    { bytes: 100 * MB, label: "100 MB" },
  },
  sms: {
    image:    { bytes: 5 * MB, label: "5 MB" },
    // Everything else on SMS/MMS varies by carrier and is unreliable —
    // block on the CRM side rather than surprise the user with a failed send.
  },
};

/**
 * Throws with a human message if the given asset can't be attached to the
 * given channel. Caller catches + returns a 400. Also called from the FE
 * (mirror function to avoid stale server round-trips).
 */
export function validateMediaForChannel(
  channel: TwChannel,
  contentType: string,
  sizeBytes: number,
): { ok: true } | { ok: false; reason: string } {
  const fam = familyFromMime(contentType);
  const cap = CAPS[channel][fam];
  if (!cap) {
    return {
      ok: false,
      reason: channel === "sms"
        ? `${contentType} is not supported over SMS/MMS. Try WhatsApp.`
        : `${contentType} is not supported.`,
    };
  }
  if (sizeBytes > cap.bytes) {
    return {
      ok: false,
      reason: `File is ${humanBytes(sizeBytes)} — ${channel === "whatsapp" ? "WhatsApp" : "SMS"} cap for ${fam} is ${cap.label}.`,
    };
  }
  return { ok: true };
}

/** Utility for size labels. Exported so FE can reuse it. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** All MIME types allowed for uploads (union of both channels). */
export const ALLOWED_UPLOAD_CONTENT_TYPES: string[] = [
  // Image
  "image/jpeg", "image/png", "image/gif", "image/webp",
  // Video
  "video/mp4", "video/3gpp", "video/quicktime",
  // Audio
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/ogg",
  // Document
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain", "text/csv", "application/rtf",
  // Archive
  "application/zip", "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/gzip", "application/x-tar",
];

/** Hard storage-side cap regardless of channel. */
export const MAX_UPLOAD_BYTES = 100 * MB;
