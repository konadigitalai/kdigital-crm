"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";

// Browser-side: hit the same-origin /api proxy in prod, direct localhost in dev.
// (Matches the resolution rule in lib/api.ts.) Routing through /api eliminates
// the cross-origin / third-party-cookie problem since vercel.app stays the
// effective request origin for both web and API.
const API_URL =
  process.env.NODE_ENV === "production"
    ? "/api"
    : (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000");

const inputCls =
  "w-full rounded-[10px] border border-rule bg-paper px-3.5 py-3 text-[14px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20";

function explainError(raw: string): string {
  if (raw.includes("Failed to fetch") || raw.includes("NetworkError")) {
    return "Can't reach the API right now. The service may be waking up — try again in a few seconds.";
  }
  if (raw.includes("429") || raw.toLowerCase().includes("too many")) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  return raw;
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({ error: "Login failed." }));
        throw new Error(body.error ?? `Login failed (${r.status}).`);
      }
      router.refresh();
      router.replace(next);
    } catch (err) {
      setError(explainError((err as Error).message));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
          Email <span className="ml-1 text-brand-magenta">*</span>
        </span>
        <input
          className={inputCls}
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          disabled={busy}
        />
      </label>

      <label className="block">
        <span className="mono-cap mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-[.12em] text-mute">
          <span>
            Password <span className="ml-1 text-brand-magenta">*</span>
          </span>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowPw((v) => !v)}
            className="rounded text-[9.5px] font-semibold tracking-[.12em] text-mute hover:text-ink"
          >
            {showPw ? "HIDE" : "SHOW"}
          </button>
        </span>
        <input
          className={inputCls}
          type={showPw ? "text" : "password"}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={busy}
        />
      </label>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2.5 text-[12.5px] leading-snug text-state-warn">
          <Icon name="info" size={14} strokeWidth={2} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !email || !password}
        className="btn-grad mt-2 w-full justify-center py-3 text-[14px] disabled:opacity-50"
      >
        {busy ? (
          <>
            <Spinner /> Signing in…
          </>
        ) : (
          <>Sign in <Icon name="arrow-right" size={14} strokeWidth={2.2} /></>
        )}
      </button>
    </form>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" strokeOpacity=".3" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
