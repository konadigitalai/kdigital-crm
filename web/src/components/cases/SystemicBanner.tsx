// Systemic-issue banner — rose/soft, same card shape as NbaBanner but in the
// app's warn palette (rgba(217,83,79,…), the same tone WarnPill in
// BatchDetail uses) so a linked systemic ref reads as "pay attention" without
// competing with the violet NBA banner above it.

export function SystemicBanner({ text }: { text: string }) {
  return (
    <div className="mb-5 rounded-[16px] border border-state-warn/25 bg-[rgba(217,83,79,.06)] p-5">
      <div className="mono-cap mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[.14em] text-state-warn">
        <span aria-hidden>⚠</span>
        Systemic issue
      </div>
      <div className="text-[13.5px] leading-[1.55] text-ink2">{text}</div>
    </div>
  );
}
