import { Topbar } from "./Topbar";
import { Icon, type IconName } from "@/components/ui/Icon";

export function ComingSoon({
  title, icon, blurb, phase,
}: {
  title: string;
  icon: IconName;
  blurb: string;
  phase: string;
}) {
  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">{title}</b></>}
        status="Coming soon"
      />

      <div className="mx-auto flex max-w-[640px] flex-col items-center px-10 pb-20 pt-24 text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-grad shadow-glow">
          <Icon name={icon} size={28} strokeWidth={1.8} className="text-white" />
        </div>
        <h1 className="font-serif text-[42px] font-normal leading-tight tracking-[-.01em]">{title}</h1>
        <p className="mt-3 max-w-[480px] text-[15px] leading-[1.55] text-mute">{blurb}</p>
        <span className="mono-cap mt-6 rounded-full border border-rule bg-paper px-3 py-1.5 text-[10px] font-semibold tracking-[.12em] text-brand-violet">
          {phase}
        </span>
      </div>
    </>
  );
}
