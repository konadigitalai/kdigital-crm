import { Icon } from "@/components/ui/Icon";
import { NotificationBell } from "./NotificationBell";

export function Topbar({
  crumb, search, status, centerSlot,
}: {
  crumb: React.ReactNode;
  search?: string;
  status?: string;
  /** Rendered between the crumb and the status — used by the lead record
   *  page for prev/next navigation. Optional; when absent the layout
   *  falls back to a single stretchy spacer. */
  centerSlot?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 flex items-center gap-[18px] border-b border-rule bg-canvas/[.82] px-9 py-3 backdrop-blur">
      <div className="mono-cap flex items-center gap-2 text-[11px] text-mute">{crumb}</div>
      <div className="flex-1" />
      {centerSlot && <div className="flex-shrink-0">{centerSlot}</div>}
      <div className="flex-1" />
      {search && (
        <div className="flex w-[280px] items-center gap-[9px] rounded-full border border-rule bg-paper px-[14px] py-2 text-[13px] text-mute">
          <Icon name="search" size={14} strokeWidth={2} />
          <span>{search}</span>
          <span className="ml-auto rounded-md border border-rule bg-warm2 px-1.5 py-0.5 font-mono text-[9px] tracking-[.06em]">⌘K</span>
        </div>
      )}
      {status && (
        <div className="mono-cap flex items-center gap-2 text-[10px] font-semibold text-state-ok">
          <span className="live-dot h-[7px] w-[7px] rounded-full bg-state-ok shadow-[0_0_10px_#2E9E6A]" />
          {status}
        </div>
      )}
      <NotificationBell />
    </div>
  );
}
