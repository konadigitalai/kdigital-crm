// Shared formatting + small helpers for the LMS surface. Kept out of the
// components so the learner portal and the admin views can't drift on how a
// duration or a due date reads.

import type { LmsResource, ResourceKind, CourseworkType, SubmissionStatus } from "./types";

/** 552 → "9:12". Used for both total length and remaining time. */
export function hms(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}

/** "9:12 left" — what the learner actually cares about mid-video. */
export function remainingLabel(r: Pick<LmsResource, "durationSeconds" | "positionSeconds">): string | null {
  if (!r.durationSeconds) return null;
  const left = r.durationSeconds - (r.positionSeconds ?? 0);
  if (left <= 0) return null;
  return `${hms(left)} left`;
}

/** Whole percent, guarding the zero-denominator case that shows up on any
 *  batch whose modules are all still drafts. */
export function pct(done: number, total: number): number {
  if (!total) return 0;
  return Math.round((done / total) * 100);
}

const DAY = 86_400_000;

/** Human due label. Deliberately vague past a week — an exact date is more
 *  useful than "in 23 days" once it's far out. */
export function dueLabel(iso: string | null | undefined): string {
  if (!iso) return "No due date";
  const due = new Date(iso).getTime();
  const now = Date.now();
  const diff = due - now;
  if (diff < 0) {
    const overdue = Math.ceil(-diff / DAY);
    return overdue <= 1 ? "Overdue" : `Overdue by ${overdue} days`;
  }
  const days = Math.ceil(diff / DAY);
  if (days <= 1) return "Due today";
  if (days === 2) return "Due tomorrow";
  if (days <= 7) {
    return `Due ${new Date(iso).toLocaleDateString(undefined, { weekday: "long" })}`;
  }
  return `Due ${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export function isOverdue(iso: string | null | undefined): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}

/** 24h "19:00" → "7:00pm". Session times come back as SQL time strings. */
export function clockLabel(t: string | null | undefined): string {
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  const h = Number(hStr), m = Number(mStr);
  if (!Number.isFinite(h)) return t;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}:00${suffix}`;
}

export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });
}

export const RESOURCE_LABEL: Record<ResourceKind, string> = {
  video: "Video",
  recording: "Class recording",
  document: "Document",
  note: "Notes",
  link: "Link",
};

export const COURSEWORK_LABEL: Record<CourseworkType, string> = {
  lab: "LAB",
  assignment: "ASGN",
  assessment: "TEST",
};

/** Tailwind classes per coursework type — mirrors the pill colours in the
 *  designs (lab warm, assignment indigo, assessment pink). */
export const COURSEWORK_CHIP: Record<CourseworkType, string> = {
  lab: "bg-amber-100 text-amber-800",
  assignment: "bg-indigo-100 text-indigo-800",
  assessment: "bg-pink-100 text-pink-800",
};

export function submissionLabel(s: SubmissionStatus | null): string {
  switch (s) {
    case "graded": return "Graded";
    case "submitted": return "Submitted";
    case "late": return "Submitted late";
    case "returned": return "Returned";
    case "draft": return "Draft";
    default: return "Not started";
  }
}

/** Vimeo player URL from a bare ID.
 *
 *  We store the ID, never a URL, so every embed option is decided here in one
 *  place. `dnt=1` keeps Vimeo from setting tracking cookies on our domain.
 *
 *  NOTE: this is not access control. Anyone who reads the page source has the
 *  ID and can open the video directly unless the video is set to "Hide from
 *  Vimeo" AND domain-restricted to the CRM's host in Vimeo's own privacy
 *  settings. Do that per video — there is no way to enforce it from here.
 */
export function vimeoEmbedUrl(videoRef: string, startAt = 0): string {
  const base = `https://player.vimeo.com/video/${encodeURIComponent(videoRef)}`;
  const params = new URLSearchParams({ dnt: "1", title: "0", byline: "0", portrait: "0" });
  if (startAt > 0) params.set("t", `${Math.floor(startAt)}s`);
  return `${base}?${params.toString()}`;
}
