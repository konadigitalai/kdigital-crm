// Pure-UI lookup tables (Tailwind class maps, etc.) — not data.
// These never round-trip through the DB; they describe how to *render* values.

import type { AvatarGrad, Heat, LeadRating, LeadTaskKind, Stage } from "./types";

export const stageStyles: Record<Stage, { bg: string; text: string; dot: string }> = {
  new:  { bg: "bg-[rgba(31,63,207,.08)]",  text: "text-brand-blue",    dot: "bg-brand-blue" },
  qual: { bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet",  dot: "bg-brand-violet" },
  demo: { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   dot: "bg-state-amber" },
  neg:  { bg: "bg-[rgba(199,25,122,.08)]", text: "text-brand-magenta", dot: "bg-brand-magenta" },
  won:  { bg: "bg-[rgba(46,158,106,.10)]", text: "text-state-ok",      dot: "bg-state-ok" },
};

export const avatarGradClass: Record<AvatarGrad, string> = {
  magenta: "bg-grad-magenta",
  violet: "bg-grad-violet",
  blue: "bg-grad-blue",
  ochre: "bg-grad-ochre",
  ok: "bg-grad-ok",
  mute: "bg-grad-mute",
  vm: "bg-grad-vm",
};

// Lead rating styles — human-set, eight values, drives pipeline columns.
// Lukewarm sits between cold and warm, uses a muted amber to signal
// "starting to warm up but still not warm-warm".
export const ratingStyles: Record<LeadRating, { label: string; bg: string; text: string; dot: string; ring: string }> = {
  "new lead":  { label: "New lead",   bg: "bg-[rgba(31,63,207,.08)]",  text: "text-brand-blue",    dot: "bg-brand-blue",    ring: "ring-warm" },
  attempted:   { label: "Attempted",  bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet",  dot: "bg-brand-violet",  ring: "ring-warm" },
  cold:        { label: "Cold",       bg: "bg-warm2",                  text: "text-mute",          dot: "bg-mute",          ring: "ring-cold" },
  lukewarm:    { label: "Lukewarm",   bg: "bg-[rgba(224,138,30,.06)]", text: "text-state-amber",   dot: "bg-state-amber",   ring: "ring-cold" },
  warm:        { label: "Warm",       bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   dot: "bg-state-amber",   ring: "ring-warm" },
  hot:         { label: "Hot",        bg: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta", dot: "bg-brand-magenta", ring: "ring-hot"  },
  superhot:    { label: "Super hot",  bg: "bg-[rgba(199,25,122,.18)]", text: "text-brand-magenta", dot: "bg-brand-magenta", ring: "ring-hot"  },
  enrolled:    { label: "Enrolled",   bg: "bg-[rgba(46,158,106,.12)]", text: "text-state-ok",      dot: "bg-state-ok",      ring: "ring-hot"  },
};

// Lead-status chip styles. Colour tracks funnel progression rather than
// sentiment, so a scan down the column reads as movement: violet (fresh) →
// blue (in conversation) → amber (committed to show up) → magenta (money on
// the table) → green (closed). Dead ends are greyed, and `strike` puts a
// line through the label so a lost lead reads as lost even in a fast scan.
export const leadStatusStyles: Record<string, { bg: string; text: string; strike?: boolean }> = {
  new:                       { bg: "bg-[rgba(107,31,184,.08)]", text: "text-brand-violet" },
  contacted:                 { bg: "bg-[rgba(31,63,207,.07)]",  text: "text-brand-blue" },
  interested:                { bg: "bg-[rgba(31,63,207,.07)]",  text: "text-brand-blue" },
  interested_in_demo:        { bg: "bg-[rgba(31,63,207,.07)]",  text: "text-brand-blue" },
  advance_talk_with_trainer: { bg: "bg-[rgba(31,63,207,.07)]",  text: "text-brand-blue" },
  demo_attended:             { bg: "bg-[rgba(46,158,106,.10)]", text: "text-state-ok" },
  visiting:                  { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber" },
  visited:                   { bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber" },
  payment_link_sent:         { bg: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta" },
  enrolled:                  { bg: "bg-[rgba(46,158,106,.14)]", text: "text-state-ok" },
  lost_lead:                 { bg: "bg-warm2",                  text: "text-hint", strike: true },
  unqualified:               { bg: "bg-warm2",                  text: "text-hint", strike: true },
};

export const LEAD_STATUS_FALLBACK_STYLE = { bg: "bg-warm2", text: "text-ink2" } as const;

// Lead-task styles. Colour encodes *what kind of commitment* it is, so a month
// of the calendar reads at a glance: green = they showed up / they paid (good),
// magenta = a live conversation is booked, violet/blue = they're coming to us,
// amber = we owe them a nudge, grey = a long shot.
//
// `hex` is here because the calendar chips draw their dot with an inline style
// (a Tailwind class can't be interpolated into a legend swatch), and `bg`/`text`
// for the chip body itself.
export const taskKindStyles: Record<
  LeadTaskKind,
  { label: string; bg: string; text: string; dot: string; hex: string }
> = {
  follow_up:    { label: "Follow-up",    bg: "bg-[rgba(224,138,30,.12)]", text: "text-state-amber",   dot: "bg-state-amber",   hex: "#E08A1E" },
  call:         { label: "Call",         bg: "bg-[rgba(199,25,122,.10)]", text: "text-brand-magenta", dot: "bg-brand-magenta", hex: "#C7197A" },
  demo:         { label: "Demo",         bg: "bg-[rgba(46,158,106,.12)]", text: "text-state-ok",      dot: "bg-state-ok",      hex: "#2E9E6A" },
  campus_visit: { label: "Campus visit", bg: "bg-[rgba(107,31,184,.09)]", text: "text-brand-violet",  dot: "bg-brand-violet",  hex: "#6B1FB8" },
  trainer_talk: { label: "Trainer talk", bg: "bg-[rgba(31,63,207,.08)]",  text: "text-brand-blue",    dot: "bg-brand-blue",    hex: "#1F3FCF" },
  enrollment:   { label: "Enrollment",   bg: "bg-[rgba(46,158,106,.14)]", text: "text-state-ok",      dot: "bg-state-ok",      hex: "#2E9E6A" },
  re_engage:    { label: "Re-engage",    bg: "bg-warm2",                  text: "text-mute",          dot: "bg-mute",          hex: "#A89DAC" },
  task:         { label: "Task",         bg: "bg-warm2",                  text: "text-ink2",          dot: "bg-ink-2",         hex: "#3B2E4A" },
};

/** "Kavya · Visit 6:00p" — the calendar chip label. Time is dropped for all-day
 *  rows, and abbreviated hard ("6:00p") because a month cell is ~140px wide. */
export function taskChipLabel(t: {
  leadName: string;
  kind: LeadTaskKind;
  dueAt: string;
  allDay: boolean;
}): string {
  const who = (t.leadName ?? "").trim().split(/\s+/)[0] || "Lead";
  const what = taskKindStyles[t.kind]?.label ?? "Task";
  if (t.allDay) return `${who} · ${what}`;
  const d = new Date(t.dueAt);
  if (Number.isNaN(d.getTime())) return `${who} · ${what}`;
  // Same IST pinning as fmtFollowup, and for the same reason: this string is
  // server-rendered then hydrated, so it must not depend on the runtime's zone.
  const parts = istTimeFmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const mins = get("minute");
  const clock = mins === "00" ? get("hour") : `${get("hour")}:${mins}`;
  return `${who} · ${what} ${clock}${get("dayPeriod").toLowerCase().startsWith("a") ? "a" : "p"}`;
}

// Score bands. The donut alone tells you "78" but not whether 78 is good —
// the band label next to it is what an advisor actually triages on. Bounds
// mirror the scoring service's own cutoffs; `heat` picks the ring colour.
const SCORE_BANDS: Array<{ min: number; label: string; heat: Heat; text: string }> = [
  { min: 85, label: "Super",   heat: "hot",  text: "text-brand-magenta" },
  { min: 70, label: "Hot",     heat: "hot",  text: "text-brand-magenta" },
  { min: 50, label: "Warm",    heat: "warm", text: "text-state-amber" },
  { min: 30, label: "Cold",    heat: "cold", text: "text-mute" },
  { min: 0,  label: "At risk", heat: "cold", text: "text-state-warn" },
];

export function scoreBand(score: number): { label: string; heat: Heat; text: string } {
  return SCORE_BANDS.find((b) => score >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
}

// Follow-up formatting. An advisor's whole day is "who do I call next", so
// the near dates are spelled out in words and today's are flagged urgent —
// a bare "2026-07-12 18:00" makes you do the date maths yourself.
//
// Every date part here is resolved in IST, never in the runtime's local zone.
// This component server-renders and then hydrates: the server runs in UTC and
// the browser in IST, so a local-zone "Today, 6:00 pm" would come back as
// "Today, 12:30 pm" on the client and mismatch. Pinning the zone makes both
// passes agree, and the users are all in India anyway.
const IST = "Asia/Kolkata";

const istDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit",
});
const istTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true,
});
const istWeekdayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long" });
const istShortFmt = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" });

/** Midnight-in-IST for a given instant, as a UTC epoch — safe to subtract. */
function istDayStart(d: Date): number {
  // en-CA gives an ISO-shaped "YYYY-MM-DD", which Date.parse reads as UTC
  // midnight. Two of these subtract to a whole number of days.
  return Date.parse(istDayFmt.format(d));
}

/** "6:00 pm" — assembled from parts, never from the formatter's own join.
 *  ICU ≥72 separates the time from the day period with U+202F (narrow no-break
 *  space) in some locales, and the server's ICU build need not match the
 *  browser's. Since this string is server-rendered and then hydrated, that one
 *  invisible codepoint would be a mismatch on every row. Taking the parts and
 *  joining with a plain ASCII space makes the output independent of ICU. */
function istTime(d: Date): string {
  const parts = istTimeFmt.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

export function fmtFollowup(
  iso: string | null | undefined,
  now: Date = new Date(),
): { label: string; urgent: boolean; muted: boolean } {
  if (!iso) return { label: "Not set", urgent: false, muted: true };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: "—", urgent: false, muted: true };

  const days = Math.round((istDayStart(d) - istDayStart(now)) / 86_400_000);

  // Overdue and today both need to jump out; "overdue" is the louder of the two.
  if (days < 0) return { label: `Overdue · ${istShortFmt.format(d)}`, urgent: true, muted: false };
  if (days === 0) return { label: `Today, ${istTime(d)}`, urgent: true, muted: false };
  if (days === 1) return { label: "Tomorrow", urgent: false, muted: false };
  if (days < 7) return { label: istWeekdayFmt.format(d), urgent: false, muted: false };
  return { label: istShortFmt.format(d), urgent: false, muted: false };
}

// Render a phone number the same way regardless of how it was stored.
//
// The CRM has three shapes in the wild, all meaning the same number:
//
//   phone "+919876543210", cc "91"    E.164 in the phone column (imports,
//                                     anything that went through
//                                     composeFullE164)
//   phone "9876543210",    cc "91"    bare local + separate cc (web intake)
//   phone "9876543210",    cc null    bare local, no cc (older manual rows)
//
// The previous version compared the cc column against "+91" while the column
// actually stores "91", so the second shape never matched and rendered as
// "91 9876543210" — no plus, no grouping — next to a correctly formatted
// "+91 98765 43210" on the row above. Same number, two appearances.
//
// Now everything is reduced to (ccDigits, localDigits) first and formatted
// from that, so storage shape cannot leak into the display.

// National-number grouping per dialling code. Only conventions worth the
// bytes: a wrong grouping reads worse than none, so anything not listed is
// shown as unbroken digits rather than guessed at.
const PHONE_GROUPS: Record<string, number[]> = {
  "91":  [5, 5],        // India        98765 43210
  "1":   [3, 3, 4],     // US / Canada  415 555 2671
  "44":  [4, 6],        // UK           7911 123456
  "61":  [3, 3, 3],     // Australia    412 345 678
  "65":  [4, 4],        // Singapore    9123 4567
  "971": [2, 3, 4],     // UAE          50 123 4567
  "974": [4, 4],        // Qatar        3312 3456
  "966": [2, 3, 4],     // Saudi        50 123 4567
  "33":  [1, 2, 2, 2, 2], // France     6 12 34 56 78
};

// Dialling codes we can recognise inside an E.164 string. Longest first so
// "+971..." is not read as "+97" then "1...".
const KNOWN_CC = Object.keys(PHONE_GROUPS).sort((a, b) => b.length - a.length);

function group(localDigits: string, ccDigits: string): string {
  const parts = PHONE_GROUPS[ccDigits];
  if (!parts) return localDigits;
  if (parts.reduce((a, b) => a + b, 0) !== localDigits.length) return localDigits;
  const out: string[] = [];
  let at = 0;
  for (const n of parts) { out.push(localDigits.slice(at, at + n)); at += n; }
  return out.join(" ");
}

export function prettyPhone(
  countryCode: string | null | undefined,
  phone: string | null | undefined,
): string {
  const raw = (phone ?? "").trim();
  if (!raw) return "";

  const colCc = (countryCode ?? "").replace(/\D/g, "");
  let ccDigits = colCc;
  let localDigits: string;

  if (raw.startsWith("+")) {
    // Self-describing: the number carries its own code, so the column is
    // ignored. It is frequently stale or duplicated on these rows.
    const all = raw.slice(1).replace(/\D/g, "");
    const match = KNOWN_CC.find((c) => all.startsWith(c) && all.length > c.length);
    if (match) {
      ccDigits = match;
      localDigits = all.slice(match.length);
    } else {
      // Unknown code: assume everything past a 10-digit tail is the code,
      // which is what the old implementation did and is right often enough.
      const ccLen = Math.max(0, Math.min(4, all.length - 10));
      ccDigits = all.slice(0, ccLen);
      localDigits = all.slice(ccLen);
    }
  } else {
    localDigits = raw.replace(/\D/g, "");
    // A bare number with no cc column: if it looks like an Indian mobile,
    // treat it as one. That is what composeFullE164 does server-side, so the
    // display agrees with what would actually be dialled.
    if (!ccDigits && localDigits.length === 10 && /^[6-9]/.test(localDigits)) {
      ccDigits = "91";
    }
  }

  if (!localDigits) return "";
  const grouped = group(localDigits, ccDigits);
  return ccDigits ? `+${ccDigits} ${grouped}` : grouped;
}

// "Priya Sharma" → "Priya S." — the advisor column is narrow and the first
// name plus an initial is enough to tell colleagues apart at a glance.
export function shortName(full: string | null | undefined): string {
  if (!full) return "";
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// Deterministic avatar gradient for people who don't carry one from the DB
// (advisors). Same name always lands on the same colour.
const GRADS: AvatarGrad[] = ["magenta", "violet", "blue", "ochre", "ok", "vm"];

export function gradFor(seed: string): AvatarGrad {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length];
}

export function initialsOf(full: string | null | undefined): string {
  if (!full) return "—";
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

