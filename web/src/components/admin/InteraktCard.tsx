"use client";

// Admin card: configure the Interakt (WhatsApp) integration — paste the
// base64 Secret Key, flip the enable toggle, and see the last sync time.
//
// The full key is never shown; the API only ever returns a masked form
// (keyMasked). Mirrors SlackWorkspaceCard's single-card shell.

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { getInteraktConfig, setInteraktConfig } from "@/lib/api";
import type { InteraktConfig } from "@/lib/types";

export function InteraktCard({ canManage }: { canManage: boolean }) {
  const [cfg, setCfg] = useState<InteraktConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyDraft, setKeyDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "save" | "clear" | "toggle">("idle");

  async function reload() {
    const fresh = await getInteraktConfig();
    setCfg(fresh);
  }

  useEffect(() => {
    getInteraktConfig()
      .then(setCfg)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function onSaveKey() {
    if (!keyDraft.trim()) return;
    setBusy("save"); setError(null);
    try {
      await setInteraktConfig({ apiKey: keyDraft.trim() });
      setKeyDraft("");
      await reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy("idle"); }
  }

  async function onClearKey() {
    if (!confirm("Clear the Interakt Secret Key? Sync will stop working until a new key is set.")) return;
    setBusy("clear"); setError(null);
    try {
      await setInteraktConfig({ apiKey: "" });
      await reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy("idle"); }
  }

  async function onToggleEnabled(next: boolean) {
    setBusy("toggle"); setError(null);
    try {
      await setInteraktConfig({ enabled: next });
      await reload();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy("idle"); }
  }

  return (
    <div className="mb-6 overflow-hidden rounded-[14px] border border-rule bg-paper">
      <div className="border-b border-rule bg-warm/50 px-5 py-3">
        <div className="text-[14px] font-semibold text-ink">Interakt (WhatsApp)</div>
        <div className="mt-0.5 text-[12px] text-mute">
          Sync leads to Interakt so their phone numbers land in your WhatsApp Business
          contacts. Paste the base64 Secret Key from Interakt → Settings → Developer
          Setting → Secret Key.
        </div>
      </div>

      <div className="px-5 py-4">
        {loading ? (
          <div className="py-3 text-[13px] text-mute">Loading…</div>
        ) : (
          <div className="space-y-3.5">
            {/* Status line */}
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              {cfg?.configured ? (
                <>
                  <span className="mono-cap text-[10px] tracking-[.1em] text-state-ok">CONFIGURED</span>
                  <Icon name="check" size={13} strokeWidth={2.4} className="text-state-ok" />
                  {cfg.keyMasked && <span className="font-mono text-[12px] text-hint">{cfg.keyMasked}</span>}
                </>
              ) : (
                <span className="mono-cap text-[10px] tracking-[.1em] text-mute">NOT CONFIGURED</span>
              )}
              {cfg?.lastSyncAt && (
                <span className="mono-cap text-[10px] text-hint">
                  · Last sync: {new Date(cfg.lastSyncAt).toLocaleString()}
                </span>
              )}
            </div>

            {/* Enable toggle */}
            {canManage && (
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-violet"
                  checked={cfg?.enabled ?? false}
                  disabled={busy !== "idle"}
                  onChange={(e) => onToggleEnabled(e.target.checked)}
                />
                <span>Enabled</span>
              </label>
            )}

            {/* Secret Key input */}
            {canManage ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <input
                    type="password"
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder={cfg?.configured ? "Paste a new Secret Key to replace…" : "Paste the base64 Secret Key…"}
                    className="min-w-0 flex-1 rounded-[10px] border border-rule bg-paper px-3 py-2 font-mono text-[12.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
                  />
                  <button
                    type="button"
                    onClick={onSaveKey}
                    disabled={busy !== "idle" || !keyDraft.trim()}
                    className="btn-grad disabled:opacity-60"
                  >
                    {busy === "save" ? "Saving…" : "Save key"}
                  </button>
                  {cfg?.configured && (
                    <button
                      type="button"
                      onClick={onClearKey}
                      disabled={busy !== "idle"}
                      className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12px] font-semibold text-state-warn hover:border-state-warn disabled:opacity-60"
                    >
                      {busy === "clear" ? "Clearing…" : "Clear"}
                    </button>
                  )}
                </div>
                <div className="text-[11.5px] text-mute">
                  The key is stored server-side and never shown again — only a masked form is returned.
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-mute">Ask an admin to configure the Interakt key.</div>
            )}

            {error && (
              <div className="rounded-md border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12.5px] text-state-warn">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
