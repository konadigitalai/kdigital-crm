// Next-best-action banner — violet/soft, mirrors the "Edify Agent" card on the
// batch detail page (web/src/components/batch/BatchDetail.tsx) so the two
// record pages read as one system.

import { Icon } from "@/components/ui/Icon";

export function NbaBanner({ nba }: { nba: { text: string; action: string } }) {
  return (
    <div className="mb-5 rounded-[16px] border border-brand-violet/15 bg-grad-soft p-5">
      <div className="mono-cap mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[.14em] text-brand-violet">
        <Icon name="spark" size={13} strokeWidth={2} />
        Next best action · Edify Agent
      </div>
      <div className="text-[13.5px] leading-[1.55] text-ink2">{nba.text}</div>
      <div className="mt-2 text-[13.5px] font-bold tracking-[-.005em] text-ink">→ {nba.action}</div>
    </div>
  );
}
