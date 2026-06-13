import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export function NotAvailablePanel({
  agentName,
  phase,
  missing,
}: {
  agentName: string;
  phase: string | null;
  missing: string | null;
}) {
  return (
    <div className="rounded-2xl border border-state-amber/40 bg-state-amber/5 p-7 shadow-card">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-[12px] bg-state-amber/15 text-state-amber">
          <Icon name="info" size={18} strokeWidth={2} />
        </span>
        <div>
          <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">
            Not yet available
          </h2>
          <p className="mt-1 text-[13.5px] text-mute">
            The <b className="font-semibold text-ink">{agentName}</b> is in the roadmap but isn't
            wired to live systems yet.
          </p>
        </div>
      </div>

      {missing && (
        <div className="rounded-[12px] border border-rule bg-paper p-4">
          <div className="mono-cap mb-1.5 text-[10px] font-semibold tracking-[.12em] text-brand-violet">
            {phase ? phase : "Roadmap"} · what it needs
          </div>
          <div className="text-[13.5px] leading-[1.55] text-ink2">{missing}</div>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <button
          type="button"
          disabled
          className="rounded-md border border-rule bg-warm/40 px-4 py-2 text-[12.5px] font-semibold text-mute"
          title="This agent isn't available yet."
        >
          Run now
        </button>
        <Link
          href="/agents"
          className="text-[12.5px] font-semibold text-brand-violet hover:underline"
        >
          ← Back to all agents
        </Link>
      </div>
    </div>
  );
}
