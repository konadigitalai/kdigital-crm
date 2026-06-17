"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { fmtDateTime } from "@/lib/useClientDate";
import {
  deleteWaConfig, registerWaPhone, saveWaConfig, subscribeWaWaba, verifyWaConnection,
} from "@/lib/api";
import type { WaConfig } from "@/lib/types";

type Step = "verify" | "register" | "subscribe";

const FIELDS: { key: keyof Creds; label: string; secret: boolean; hint?: string }[] = [
  { key: "phone_number_id",      label: "Phone number ID",      secret: false, hint: "From Meta WhatsApp Manager → API setup" },
  { key: "waba_id",              label: "WABA ID",              secret: false },
  { key: "app_id",               label: "App ID",               secret: false },
  { key: "app_secret",           label: "App secret",           secret: true,  hint: "From Meta App Dashboard → Settings → Basic" },
  { key: "system_user_token",    label: "System user token",    secret: true,  hint: "Permanent token from Meta Business Manager" },
  { key: "webhook_verify_token", label: "Webhook verify token", secret: true,  hint: "Any string you choose; paste the same value into Meta when configuring the webhook" },
];

interface Creds {
  phone_number_id: string;
  waba_id: string;
  app_id: string;
  app_secret: string;
  system_user_token: string;
  webhook_verify_token: string;
}

const EMPTY: Creds = {
  phone_number_id: "", waba_id: "", app_id: "",
  app_secret: "", system_user_token: "", webhook_verify_token: "",
};

export function WaConnectionCard({
  initialConfig, canManage,
}: { initialConfig: WaConfig; canManage: boolean }) {
  const [config, setConfig] = useState<WaConfig>(initialConfig);
  // Render dates client-only — server's locale (en-US, UTC) and client's
  // locale (en-IN, Asia/Kolkata) format toLocaleString() differently and
  // cause hydration mismatches. Mounted-flag gates the formatted output.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [creds, setCreds] = useState<Creds>(EMPTY);
  const [editing, setEditing] = useState(!initialConfig.configured);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<Step | "save" | "delete" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  function flash(kind: "ok" | "err" | "info", text: string) {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 6000);
  }

  async function reload() {
    // Refetch via the existing helper (server component reload would be cleaner;
    // for v1 we just re-call the API).
    const { getWaConfig } = await import("@/lib/api");
    setConfig(await getWaConfig());
  }

  async function handleSave() {
    if (!canManage) return;
    setBusy("save");
    try {
      const out = await saveWaConfig({ credentials: creds });
      if (out.verify.ok) {
        flash("ok", `Saved + verified. Status: ${out.status}.`);
        setEditing(false);
        setCreds(EMPTY);
        await reload();
      } else {
        flash("err", `Saved, but Meta verify failed: ${out.verify.error ?? `HTTP ${out.verify.httpStatus}`}`);
        await reload();
      }
    } catch (err) {
      flash("err", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleVerify() {
    if (!canManage) return;
    setBusy("verify");
    try {
      const out = await verifyWaConnection();
      if (out.ok) {
        flash("ok", "Meta verified the phone number — connection is healthy.");
        await reload();
      } else {
        flash("err", `Meta error: ${out.error ?? `HTTP ${out.httpStatus}`}`);
      }
    } catch (err) {
      flash("err", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleRegister() {
    if (!canManage) return;
    if (!/^\d{6}$/.test(pin)) { flash("err", "PIN must be exactly 6 digits."); return; }
    setBusy("register");
    try {
      const out = await registerWaPhone(pin);
      if (out.ok) {
        flash("ok", "Phone registered with this app. Move on to Subscribe.");
        await reload();
      } else {
        flash("err", `Meta register failed: ${out.error ?? `HTTP ${out.httpStatus}`}`);
      }
    } catch (err) {
      flash("err", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleSubscribe() {
    if (!canManage) return;
    setBusy("subscribe");
    try {
      const out = await subscribeWaWaba();
      if (out.ok) {
        flash("ok", "WABA subscribed. Inbound webhooks will route to this CRM.");
        await reload();
      } else {
        flash("err", `Meta subscribe failed: ${out.error ?? `HTTP ${out.httpStatus}`}`);
      }
    } catch (err) {
      flash("err", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete() {
    if (!canManage) return;
    if (!confirm("Disconnect WhatsApp? Stored credentials will be cleared. Inbound webhooks will stop arriving.")) return;
    setBusy("delete");
    try {
      await deleteWaConfig();
      flash("info", "Disconnected.");
      setCreds(EMPTY);
      setEditing(true);
      await reload();
    } catch (err) {
      flash("err", (err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const statusPill = (() => {
    if (config.status === "connected") return { color: "bg-state-ok/15 text-state-ok ring-state-ok/30", label: "Connected" };
    return { color: "bg-state-amber/15 text-state-amber ring-state-amber/30", label: "Disconnected" };
  })();

  const stepDot = (done: boolean) => (
    <span className={"inline-block h-2 w-2 rounded-full " + (done ? "bg-state-ok" : "bg-rule2")} />
  );

  return (
    <div className="rounded-[16px] border border-rule bg-paper p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[18px] font-semibold text-ink">Connection</h2>
          <p className="mt-1 text-[13px] text-mute">
            One Meta Cloud API number per tenant. Required for all sending and receiving.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${statusPill.color}`}>
          {statusPill.label}
        </span>
      </div>

      {/* Status summary */}
      {config.configured && (
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-[10px] bg-warm/40 p-3 text-[12.5px]">
          <div>
            <div className="text-mute">Display number</div>
            <div className="font-mono text-ink">{config.displayPhoneNumber ?? "—"}</div>
          </div>
          <div>
            <div className="text-mute">Verified name</div>
            <div className="text-ink">{config.verifiedName ?? "—"}</div>
          </div>
          <div>
            <div className="text-mute">Quality</div>
            <div className="text-ink">{config.qualityRating ?? "—"}</div>
          </div>
          <div>
            <div className="text-mute">Connected at</div>
            <div className="text-ink">{mounted && config.connectedAt ? new Date(config.connectedAt).toLocaleString() : "—"}</div>
          </div>
        </div>
      )}

      {/* 3-step setup */}
      {config.configured && (
        <div className="mb-4 rounded-[10px] border border-rule p-3">
          <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.08em] text-mute">Setup steps</div>
          <ol className="space-y-2 text-[13px] text-ink">
            <li className="flex items-center justify-between">
              <span className="flex items-center gap-2">{stepDot(!!config.connectedAt)} 1. Verify</span>
              <button onClick={handleVerify} disabled={!canManage || busy !== null}
                className="rounded-md border border-rule bg-paper px-3 py-1 text-[12px] font-semibold text-ink hover:border-rule2 disabled:opacity-50">
                {busy === "verify" ? "Verifying…" : "Re-verify"}
              </button>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">{stepDot(!!config.registeredAt)} 2. Register (one-time)</span>
              <span className="flex items-center gap-2">
                <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6-digit PIN" maxLength={6}
                  className="w-[110px] rounded-md border border-rule bg-paper px-2.5 py-1 text-[12.5px] font-mono tracking-[0.2em] text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20" />
                <button onClick={handleRegister} disabled={!canManage || busy !== null || pin.length !== 6}
                  className="rounded-md border border-rule bg-paper px-3 py-1 text-[12px] font-semibold text-ink hover:border-rule2 disabled:opacity-50">
                  {busy === "register" ? "Registering…" : "Register"}
                </button>
              </span>
            </li>
            <li className="flex items-center justify-between">
              <span className="flex items-center gap-2">{stepDot(!!config.subscribedAt)} 3. Subscribe (one-time)</span>
              <button onClick={handleSubscribe} disabled={!canManage || busy !== null}
                className="rounded-md border border-rule bg-paper px-3 py-1 text-[12px] font-semibold text-ink hover:border-rule2 disabled:opacity-50">
                {busy === "subscribe" ? "Subscribing…" : "Subscribe"}
              </button>
            </li>
          </ol>
        </div>
      )}

      {/* Credentials editor */}
      {editing ? (
        <div className="space-y-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="mono-cap mb-0.5 block text-[10px] font-semibold tracking-[.1em] text-mute">{f.label}</span>
              <input
                value={creds[f.key]}
                onChange={(e) => setCreds((p) => ({ ...p, [f.key]: e.target.value }))}
                type={f.secret ? "password" : "text"}
                spellCheck={false}
                className="w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-[12.5px] font-mono text-ink focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20"
              />
              {f.hint && <span className="mt-0.5 block text-[11px] text-hint">{f.hint}</span>}
            </label>
          ))}
          <div className="mt-3 flex items-center justify-end gap-2">
            {config.configured && (
              <button onClick={() => { setEditing(false); setCreds(EMPTY); }}
                className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:border-rule2">
                Cancel
              </button>
            )}
            <button onClick={handleSave} disabled={!canManage || busy !== null}
              className="rounded-md bg-brand-violet px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {busy === "save" ? "Saving…" : "Save & verify"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button onClick={() => setEditing(true)} disabled={!canManage}
            className="rounded-md border border-rule bg-paper px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:border-rule2 disabled:opacity-50">
            <Icon name="settings" size={12} strokeWidth={2} className="mr-1.5 inline-block" /> Edit credentials
          </button>
          <button onClick={handleDelete} disabled={!canManage || busy !== null}
            className="ml-auto rounded-md border border-state-amber/40 bg-state-amber/5 px-3 py-1.5 text-[12.5px] font-semibold text-state-amber hover:bg-state-amber/10 disabled:opacity-50">
            {busy === "delete" ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      )}

      {msg && (
        <div className={
          "mt-3 rounded-md border px-3 py-2 text-[12.5px] " +
          (msg.kind === "ok"   ? "border-state-ok/40 bg-state-ok/5 text-state-ok"
          : msg.kind === "err" ? "border-state-bad/40 bg-state-bad/5 text-state-bad"
          : "border-rule bg-warm/40 text-ink")
        }>
          {msg.text}
        </div>
      )}
    </div>
  );
}
