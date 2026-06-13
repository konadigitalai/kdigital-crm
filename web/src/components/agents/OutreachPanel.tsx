"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { LeadPicker } from "@/components/agents/LeadPicker";
import { runOutreachDraft } from "@/lib/api";
import type { Lead } from "@/lib/types";

export function OutreachPanel({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    leadNumber: string; approvalId: string;
    draft: { subject: string; body: string };
  } | null>(null);

  async function onRun() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const out = await runOutreachDraft(picked);
      setResult({ leadNumber: picked, approvalId: out.approvalId, draft: out.draft });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-rule bg-paper p-5">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] bg-brand-magenta text-white">
            <Icon name="spark" size={16} strokeWidth={2} />
          </span>
          <div>
            <div className="text-[15px] font-bold tracking-tight">Draft a follow-up email</div>
            <div className="mt-0.5 text-[12.5px] text-mute">
              Pick a lead — the agent reads their full timeline, signals and rating, then drafts a
              3-5 sentence email. The draft creates an approval row; nothing is sent until you click
              <b className="font-semibold text-ink"> Approve & send</b> on the lead's record page.
            </div>
          </div>
        </div>

        <LeadPicker leads={leads} value={picked} onChange={setPicked} disabled={busy} />

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={onRun}
            disabled={!picked || busy}
            className="btn-grad disabled:opacity-50"
          >
            {busy ? "Drafting…" : "Generate draft"}
          </button>
          <span className="text-[11.5px] text-mute">
            Tip: the same action exists on each lead's record page as <b>Draft outreach</b>.
          </span>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-4 rounded-[12px] border border-state-ok/40 bg-state-ok/5 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Icon name="check" size={14} strokeWidth={2.4} className="text-state-ok" />
              <span className="text-[12.5px] font-semibold text-state-ok">
                Draft created — awaiting approval
              </span>
            </div>
            <div className="rounded-[10px] border border-rule bg-paper p-3">
              <div className="text-[13px] font-bold text-ink">
                <span className="mono-cap mr-2 text-[9.5px] tracking-[.12em] text-mute">SUBJECT</span>
                {result.draft.subject}
              </div>
              <div className="mt-1 whitespace-pre-line text-[13px] leading-[1.55] text-ink2">
                {result.draft.body}
              </div>
            </div>
            <Link
              href={`/records/${result.leadNumber}`}
              className="mt-3 inline-flex text-[12.5px] font-semibold text-brand-violet hover:underline"
            >
              Open lead to approve & send →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
