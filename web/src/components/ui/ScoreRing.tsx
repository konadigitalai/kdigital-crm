import { cn } from "@/lib/cn";
import type { Heat } from "@/lib/types";

const heatCls: Record<Heat, { ring: string; text: string }> = {
  hot:  { ring: "ring-hot",  text: "text-brand-magenta" },
  warm: { ring: "ring-warm", text: "text-state-amber" },
  cold: { ring: "ring-cold", text: "text-mute" },
};

export function ScoreRing({
  score, heat, size = 34, inner = 26, fontSize = 11,
}: {
  score: number; heat: Heat; size?: number; inner?: number; fontSize?: number;
}) {
  const cfg = heatCls[heat];
  return (
    <div
      className={cn("grid place-items-center rounded-full font-mono font-bold", cfg.ring, cfg.text)}
      style={{ width: size, height: size, ["--p" as string]: `${score}%`, fontSize }}
    >
      <span
        className="grid place-items-center rounded-full bg-paper not-italic"
        style={{ width: inner, height: inner }}
      >
        {score}
      </span>
    </div>
  );
}
