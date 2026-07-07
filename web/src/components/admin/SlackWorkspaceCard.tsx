"use client";

// Admin card: paste + verify + save a Slack bot token, and refresh the
// cached channel/user directory. This unlocks the dynamic "pick channel
// or person" flow on the "Share to Slack" button.
//
// If no token is saved yet, the manual-share dialog silently falls back
// to the legacy per-surface webhook, so nothing breaks during rollout.

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { getSlackWorkspace, refreshSlackDirectory, saveSlackBotToken, testSlackBotToken, type SlackWorkspaceInfo } from "@/lib/api";

export function SlackWorkspaceCard({ canManage }: { canManage: boolean }) {
  const [ws, setWs] = useState<SlackWorkspaceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tokenDraft, setTokenDraft] = useState("");
  const [savedInfo, setSavedInfo] = useState<{ teamName?: string; botUser?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "save" | "test" | "refresh">("idle");
  const [refreshResult, setRefreshResult] = useState<{ channelCount: number; userCount: number } | null>(null);

  useEffect(() => {
    getSlackWorkspace()
      .then((r) => setWs(r.workspace))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function onSave() {
    if (!tokenDraft.trim()) return;
    setBusy("save"); setError(null); setSavedInfo(null);
    try {
      const r = await saveSlackBotToken(tokenDraft.trim());
      setSavedInfo({ teamName: r.teamName, botUser: r.botUser });
      setTokenDraft("");
      // Refresh workspace view.
      const fresh = await getSlackWorkspace();
      setWs(fresh.workspace);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy("idle"); }
  }

  async function onTest() {
    setBusy("test"); setError(null); setSavedInfo(null);
    try {
      const r = await testSlackBotToken();
      if (r.ok) setSavedInfo({ teamName: r.teamName, botUser: r.botUser });
      else setError(r.error ?? "test failed");
    } catch (err) { setError((err as Error).message); }
    finally { setBusy("idle"); }
  }

  async function onRefresh() {
    setBusy("refresh"); setError(null); setRefreshResult(null);
    try {
      const r = await refreshSlackDirectory();
      setRefreshResult({ channelCount: r.channelCount, userCount: r.userCount });
    } catch (err) { setError((err as Error).message); }
    finally { setBusy("idle"); }
  }

  return (
    <div className="mb-6 overflow-hidden rounded-[14px] border border-rule bg-paper">
      <div className="border-b border-rule bg-warm/50 px-5 py-3">
        <div className="text-[14px] font-semibold text-ink">Bot workspace</div>
        <div className="mt-0.5 text-[12px] text-mute">
          A bot token unlocks the dynamic "pick channel or person" flow. Without it, the "Share to Slack" button
          uses the pre-configured webhook targets below.
        </div>
      </div>

      <div className="px-5 py-4">
        {loading ? (
          <div className="py-3 text-[13px] text-mute">Loading…</div>
        ) : ws?.hasToken ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="mono-cap text-[10px] tracking-[.1em] text-mute">CONNECTED</span>
              <span className="font-semibold text-ink">{ws.teamName ?? "(team)"}</span>
              {ws.teamId && <span className="mono-cap text-[10px] text-hint">{ws.teamId}</span>}
              {ws.installedAt && (
                <span className="mono-cap text-[10px] text-hint">
                  · installed {new Date(ws.installedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy !== "idle"}
                  onClick={onTest}
                  className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-60"
                >
                  {busy === "test" ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  disabled={busy !== "idle"}
                  onClick={onRefresh}
                  className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet disabled:opacity-60"
                >
                  {busy === "refresh" ? "Refreshing…" : "Refresh directory (channels + users)"}
                </button>
                <details className="w-full">
                  <summary className="cursor-pointer select-none text-[11.5px] font-semibold text-mute hover:text-ink">
                    Replace bot token
                  </summary>
                  <div className="mt-2">
                    <TokenInput
                      value={tokenDraft}
                      onChange={setTokenDraft}
                      onSave={onSave}
                      busy={busy === "save"}
                      buttonLabel="Save new token"
                    />
                  </div>
                </details>
              </div>
            )}
          </div>
        ) : canManage ? (
          <div className="space-y-3">
            <div className="text-[13px] text-ink2">
              Paste the Bot User OAuth Token from api.slack.com/apps → your app → OAuth &amp; Permissions.
              It starts with <span className="font-mono">xoxb-</span>.
            </div>
            <TokenInput
              value={tokenDraft}
              onChange={setTokenDraft}
              onSave={onSave}
              busy={busy === "save"}
              buttonLabel="Save + verify"
            />
            <div className="text-[11.5px] text-mute">
              Required scopes: <span className="font-mono">channels:read</span>,{" "}
              <span className="font-mono">groups:read</span>,{" "}
              <span className="font-mono">users:read</span>,{" "}
              <span className="font-mono">chat:write</span>,{" "}
              <span className="font-mono">im:write</span>. Invite the bot to any channel it should post into.
            </div>
          </div>
        ) : (
          <div className="text-[13px] text-mute">No bot token configured. Ask an admin to set one up.</div>
        )}

        {savedInfo && (
          <div className="mt-3 rounded-md border border-state-ok/30 bg-state-ok/10 px-3 py-2 text-[12.5px] text-state-ok">
            <Icon name="check" size={12} strokeWidth={2.4} className="mr-1 inline" />
            Connected to <b>{savedInfo.teamName}</b>{savedInfo.botUser ? <> as <b>@{savedInfo.botUser}</b></> : null}.
          </div>
        )}
        {refreshResult && (
          <div className="mt-3 rounded-md border border-state-ok/30 bg-state-ok/10 px-3 py-2 text-[12.5px] text-state-ok">
            <Icon name="check" size={12} strokeWidth={2.4} className="mr-1 inline" />
            Directory refreshed: <b>{refreshResult.channelCount}</b> channels, <b>{refreshResult.userCount}</b> users.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenInput({
  value, onChange, onSave, busy, buttonLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  busy: boolean;
  buttonLabel: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="xoxb-…"
        className="min-w-0 flex-1 rounded-[10px] border border-rule bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
      />
      <button
        type="button"
        onClick={onSave}
        disabled={busy || !value.trim()}
        className="btn-grad disabled:opacity-60"
      >
        {busy ? "Saving…" : buttonLabel}
      </button>
    </div>
  );
}
