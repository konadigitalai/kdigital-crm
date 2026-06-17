"use client";

/**
 * Three-pane inbox.
 *
 *   ┌────────────────┬───────────────────────────┬────────────────────┐
 *   │ filters        │  active thread             │  contact pane      │
 *   │ + thread list  │  (messages + reply box)    │  (party + tags +   │
 *   │                │                            │   promote-to-lead) │
 *   └────────────────┴───────────────────────────┴────────────────────┘
 *
 * Owns: selected conversation, filter state, thread + tags fetched on
 * select, polling for fresh thread/list every 8s when window is focused.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assignWaConversation, getWaConversation, getWaConversations,
  markWaConversationRead, promoteWaConversationToLead, sendWaMessage,
  setWaConversationStatus, tagWaConversation, untagWaConversation,
} from "@/lib/api";
import type {
  AdminUser, CurrentUser, WaConversationDetail, WaConversationListItem,
  WaConversationStatus, WaTag, WaTemplate,
} from "@/lib/types";
import { ThreadList } from "./ThreadList";
import { ThreadView } from "./ThreadView";
import { ReplyBox } from "./ReplyBox";
import { ContactPane } from "./ContactPane";
import { Icon } from "@/components/ui/Icon";

const POLL_MS = 8000;

type AssigneeFilter = "all" | "me" | "unassigned";

export function InboxShell({
  initialConversations,
  tags,
  templates,
  users,
  currentUser,
  canSend,
  canManageTags,
  configStatus,
}: {
  initialConversations: WaConversationListItem[];
  tags: WaTag[];
  templates: WaTemplate[];
  users: AdminUser[];
  currentUser: CurrentUser | null;
  canSend: boolean;
  canManageTags: boolean;
  configStatus: "connected" | "disconnected";
}) {
  const [conversations, setConversations] = useState<WaConversationListItem[]>(initialConversations);
  const [statusFilter,   setStatusFilter]   = useState<WaConversationStatus | "all">("open");
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialConversations[0]?.id ?? null);
  const [thread, setThread] = useState<WaConversationDetail | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Polling needs the latest filter args; capturing them via refs avoids
  // tearing them down/up on every state change.
  const filterRef = useRef({ statusFilter, assigneeFilter, search });
  useEffect(() => { filterRef.current = { statusFilter, assigneeFilter, search }; }, [statusFilter, assigneeFilter, search]);

  // ── Load list (initial filter change + poll) ───────────────────────────
  const refreshList = useCallback(async () => {
    try {
      const f = filterRef.current;
      const next = await getWaConversations({
        status: f.statusFilter,
        assignee: f.assigneeFilter === "all" ? undefined : f.assigneeFilter,
        q: f.search || undefined,
        limit: 100,
      });
      setConversations(next);
    } catch (err) {
      // Polling failures are silent — the existing list stays usable.
      console.error(err);
    }
  }, []);

  // Refetch on filter / search change (debounced).
  useEffect(() => {
    const t = setTimeout(refreshList, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [statusFilter, assigneeFilter, search, refreshList]);

  // Poll list every 8s when document visible.
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(refreshList, POLL_MS); };
    const stop  = () => { if (id) { clearInterval(id); id = null; } };
    const onVis = () => (document.hidden ? stop() : start());
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [refreshList]);

  // ── Load thread when selection changes ─────────────────────────────────
  const loadThread = useCallback(async (id: string) => {
    setThreadLoading(true);
    setError(null);
    try {
      const t = await getWaConversation(id);
      setThread(t);
      // Eagerly mark read so the unread badge clears for the user; the
      // server-side update happens in the background.
      if ((t.conversation.unreadCount ?? 0) > 0) {
        markWaConversationRead(id).catch(() => undefined);
        setConversations((all) => all.map((c) => c.id === id ? { ...c, unreadCount: 0 } : c));
      }
    } catch (err) {
      setError((err as Error).message);
      setThread(null);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setThread(null); return; }
    loadThread(selectedId);
  }, [selectedId, loadThread]);

  // Poll thread every 8s when focused.
  useEffect(() => {
    if (!selectedId) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(() => loadThread(selectedId), POLL_MS); };
    const stop  = () => { if (id) { clearInterval(id); id = null; } };
    const onVis = () => (document.hidden ? stop() : start());
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [selectedId, loadThread]);

  // ── Mutations ──────────────────────────────────────────────────────────

  async function onSend(input: { body?: string; templateId?: string; variables?: Record<string, string> }) {
    if (!selectedId) return;
    setError(null);
    const r = await sendWaMessage(selectedId, input);
    if (!r.ok) {
      setError(r.error ?? "Send failed.");
      return false;
    }
    // Refresh thread + list so the new message appears.
    await Promise.all([loadThread(selectedId), refreshList()]);
    return true;
  }

  async function onAssign(userId: string | null) {
    if (!selectedId) return;
    await assignWaConversation(selectedId, userId);
    await Promise.all([loadThread(selectedId), refreshList()]);
  }

  async function onChangeStatus(status: WaConversationStatus) {
    if (!selectedId) return;
    await setWaConversationStatus(selectedId, status);
    await Promise.all([loadThread(selectedId), refreshList()]);
  }

  async function onAddTag(tagId: string) {
    if (!selectedId) return;
    await tagWaConversation(selectedId, tagId);
    await loadThread(selectedId);
  }

  async function onRemoveTag(tagId: string) {
    if (!selectedId) return;
    await untagWaConversation(selectedId, tagId);
    await loadThread(selectedId);
  }

  async function onPromoteToLead(): Promise<{ ok: boolean; number: string; alreadyLead: boolean } | null> {
    if (!selectedId) return null;
    try {
      const r = await promoteWaConversationToLead(selectedId);
      // Refresh so the new lead number shows up in the contact pane.
      await Promise.all([loadThread(selectedId), refreshList()]);
      return r;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }

  // ── Sendable users for assign menu ─────────────────────────────────────
  // Filter to active users. Without users.manage, users[] is empty and
  // we degrade to "assign to me" / "unassign" only.
  const sendableUsers = useMemo(
    () => users.filter((u) => u.active),
    [users],
  );

  // Banner when WhatsApp isn't configured at all.
  if (configStatus !== "connected") {
    return (
      <div className="px-9 pb-[60px] pt-7">
        <div className="flex items-start gap-4 rounded-2xl border border-state-amber/40 bg-state-amber/5 p-6">
          <span className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-xl bg-state-amber/15 text-state-amber">
            <Icon name="info" size={20} strokeWidth={1.8} />
          </span>
          <div>
            <h2 className="font-serif text-[22px] tracking-[-.005em]">WhatsApp not configured</h2>
            <p className="mt-1.5 text-[13.5px] text-mute">
              An admin needs to paste Meta WhatsApp Cloud API credentials and complete the verify / register / subscribe flow before the inbox can receive messages.
            </p>
            <p className="mt-1 text-[12.5px] text-mute">
              Admin → Integrations → WhatsApp.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid h-[calc(100vh-49px)] overflow-hidden"
      style={{ gridTemplateColumns: "320px minmax(0, 1fr) 320px" }}
    >
      {/* LEFT — filters + thread list */}
      <aside className="flex h-full min-h-0 flex-col border-r border-rule bg-paper">
        <div className="flex flex-shrink-0 flex-col gap-2 border-b border-rule px-4 py-3">
          <div className="flex gap-1.5">
            {(["open", "pending", "closed", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={
                  "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold capitalize transition " +
                  (statusFilter === s
                    ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
                    : "border-rule bg-paper text-mute hover:border-rule2 hover:text-ink")
                }
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            {(
              [
                { v: "all", label: "All" },
                { v: "me", label: "Mine" },
                { v: "unassigned", label: "Unassigned" },
              ] as Array<{ v: AssigneeFilter; label: string }>
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setAssigneeFilter(opt.v)}
                className={
                  "rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition " +
                  (assigneeFilter === opt.v
                    ? "border-brand-violet bg-brand-violet/10 text-brand-violet"
                    : "border-rule bg-paper text-mute hover:border-rule2 hover:text-ink")
                }
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder="Search name, phone, message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[13px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
          />
        </div>
        <ThreadList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={setSelectedId}
          currentUserId={currentUser?.id ?? null}
        />
      </aside>

      {/* CENTER — thread view + reply box */}
      <main className="flex h-full min-h-0 flex-col bg-warm/30">
        {error && (
          <div className="flex-shrink-0 border-b border-state-warn/40 bg-state-warn/10 px-4 py-2 text-[12.5px] text-state-warn">
            {error}
            <button onClick={() => setError(null)} className="ml-3 text-mute hover:text-ink" aria-label="Dismiss">×</button>
          </div>
        )}
        {!selectedId ? (
          <EmptySelected />
        ) : threadLoading && !thread ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-mute">Loading…</div>
        ) : thread ? (
          <>
            <ThreadView thread={thread} />
            <div className="flex-shrink-0 border-t border-rule bg-paper">
              <ReplyBox
                conversation={thread.conversation}
                templates={templates}
                canSend={canSend}
                onSend={onSend}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-mute">Couldn&apos;t load thread.</div>
        )}
      </main>

      {/* RIGHT — contact pane */}
      <aside className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-rule bg-paper">
        {thread ? (
          <ContactPane
            thread={thread}
            allTags={tags}
            users={sendableUsers}
            currentUser={currentUser}
            canSend={canSend}
            canManageTags={canManageTags}
            onAssign={onAssign}
            onChangeStatus={onChangeStatus}
            onAddTag={onAddTag}
            onRemoveTag={onRemoveTag}
            onPromoteToLead={onPromoteToLead}
          />
        ) : (
          <div className="p-6 text-[13px] text-mute">Pick a conversation to see contact details.</div>
        )}
      </aside>
    </div>
  );
}

function EmptySelected() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-warm2 text-mute">
        <Icon name="inbox" size={26} strokeWidth={1.6} />
      </div>
      <div>
        <div className="text-[14px] font-semibold text-ink">No conversation selected</div>
        <div className="mt-1 text-[12.5px] text-mute">Pick a thread on the left to read it here.</div>
      </div>
    </div>
  );
}
