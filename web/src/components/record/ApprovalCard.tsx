"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { decideApproval } from "@/lib/api";

interface Proposed {
  channel?: string;
  subject?: string;
  body?: string;
}

export function ApprovalCard({
  approval,
}: {
  approval: { id: string; actionType: string; mode: string; status: string; proposed: unknown };
}) {
  const router = useRouter();
  const proposed: Proposed =
    approval.proposed && typeof approval.proposed === "object" ? (approval.proposed as Proposed) : {};
  const initialBody = proposed.body ?? "";
  const initialSubject = proposed.subject ?? "";

  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      const editedSubject = subject.trim();
      const editedBody = body.trim();
      const isEdited =
        editing &&
        decision === "approve" &&
        (editedSubject !== initialSubject || editedBody !== initialBody);
      await decideApproval(
        approval.id,
        decision,
        isEdited ? { ...proposed, subject: editedSubject, body: editedBody } : undefined,
      );
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-[22px] overflow-hidden rounded-2xl border border-state-amber/40 bg-state-amber/5 p-5 shadow-card">
      <div className="mb-3 flex items-start gap-3">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] bg-state-amber/15 text-state-amber">
          <Icon name="info" size={16} strokeWidth={2} />
        </span>
        <div className="flex-1">
          <div className="text-[14px] font-bold tracking-tight">
            Outreach Agent · awaiting your approval
          </div>
          <div className="mono-cap mt-0.5 text-[10px] tracking-[.06em] text-mute">
            {approval.actionType.replace(/_/g, " ")} · mode: {approval.mode}
          </div>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2.5">
          <input
            className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13.5px] font-semibold text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
          />
          <textarea
            className="w-full resize-y rounded-[10px] border border-rule bg-paper px-3 py-2 text-[13px] leading-[1.55] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Body"
          />
        </div>
      ) : (
        <div className="space-y-1 rounded-[10px] border border-rule bg-paper p-3">
          {proposed.subject && (
            <div className="text-[13px] font-semibold tracking-tight text-ink">
              <span className="mono-cap mr-2 text-[9.5px] font-bold tracking-[.12em] text-mute">SUBJECT</span>
              {proposed.subject}
            </div>
          )}
          {proposed.body && (
            <div className="whitespace-pre-line text-[13px] leading-[1.55] text-ink2">
              {proposed.body}
            </div>
          )}
          {!proposed.subject && !proposed.body && (
            <pre className="overflow-x-auto text-[12px] text-mute">
              {JSON.stringify(approval.proposed, null, 2)}
            </pre>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => decide("approve")}
          disabled={busy !== null}
          className="btn-grad disabled:opacity-60"
        >
          {busy === "approve" ? "Sending…" : "Approve & send"}
        </button>
        <button
          type="button"
          onClick={() => decide("reject")}
          disabled={busy !== null}
          className="btn disabled:opacity-50"
        >
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy !== null}
            className="btn disabled:opacity-50"
          >
            Edit draft
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setSubject(initialSubject);
              setBody(initialBody);
            }}
            disabled={busy !== null}
            className="btn disabled:opacity-50"
          >
            Cancel edit
          </button>
        )}
      </div>
    </div>
  );
}
