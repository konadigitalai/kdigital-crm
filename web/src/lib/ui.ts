// Pure-UI lookup tables (Tailwind class maps, etc.) — not data.
// These never round-trip through the DB; they describe how to *render* values.

import type { AvatarGrad, Stage } from "./types";

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

