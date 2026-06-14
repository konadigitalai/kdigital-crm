"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import {
  activateUser,
  createUser,
  deactivateUser,
  resetUserPassword,
  updateUser,
} from "@/lib/api";
import type { AdminUser, ModuleAccess, UserGroupSummary } from "@/lib/types";

const ROLES = ["admin", "advisor", "service_rep", "readonly"] as const;

type Mode =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "editing"; user: AdminUser }
  | { kind: "resetting"; user: AdminUser };

export function UsersTable({
  initial,
  groups,
  modules,
}: {
  initial: AdminUser[];
  groups: UserGroupSummary[];
  modules: ModuleAccess[];
}) {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groupsById = useMemo(() => {
    const m = new Map<string, UserGroupSummary>();
    groups.forEach((g) => m.set(g.id, g));
    return m;
  }, [groups]);

  function reload() { router.refresh(); }

  async function onCreate(input: {
    email: string;
    name: string;
    role: string;
    password: string;
    groupIds: string[];
  }) {
    setBusy("create");
    setError(null);
    try {
      const { user } = await createUser({
        email: input.email,
        name: input.name || undefined,
        role: input.role,
        password: input.password || undefined,
        groupIds: input.groupIds,
      });
      // Server returns minimal user shape; fold groups locally so the row
      // renders without a refetch.
      const fullGroups = input.groupIds
        .map((id) => groupsById.get(id))
        .filter((g): g is UserGroupSummary => Boolean(g))
        .map((g) => ({ id: g.id, name: g.name }));
      setUsers((all) => [
        ...all,
        {
          ...user,
          email: input.email,
          name: input.name || null,
          role: input.role,
          active: true,
          has_password: !!input.password,
          groups: fullGroups,
        } as AdminUser,
      ]);
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onUpdate(u: AdminUser, patch: { name?: string; role?: string; groupIds: string[] }) {
    setBusy(u.id);
    setError(null);
    try {
      await updateUser(u.id, patch);
      setUsers((all) =>
        all.map((x) =>
          x.id === u.id
            ? {
                ...x,
                ...patch,
                groups: patch.groupIds
                  .map((id) => groupsById.get(id))
                  .filter((g): g is UserGroupSummary => Boolean(g))
                  .map((g) => ({ id: g.id, name: g.name })),
              }
            : x,
        ),
      );
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onToggleActive(u: AdminUser) {
    setBusy(u.id);
    setError(null);
    try {
      if (u.active) await deactivateUser(u.id);
      else await activateUser(u.id);
      setUsers((all) => all.map((x) => (x.id === u.id ? { ...x, active: !x.active } : x)));
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onResetPassword(u: AdminUser, password: string) {
    setBusy(u.id);
    setError(null);
    try {
      await resetUserPassword(u.id, password);
      setUsers((all) => all.map((x) => (x.id === u.id ? { ...x, has_password: true } : x)));
      setMode({ kind: "idle" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {users.length} user{users.length === 1 ? "" : "s"} ·{" "}
          {users.filter((u) => u.active).length} active
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New user
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <Row hdr>
          <div>User</div>
          <div>Role</div>
          <div>Groups</div>
          <div className="text-center">Password</div>
          <div className="text-right">Actions</div>
        </Row>

        {users.length === 0 ? (
          <div className="px-[22px] py-10 text-center text-[13px] text-mute">No users yet.</div>
        ) : (
          users.map((u) => (
            <Row key={u.id} dimmed={!u.active}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold tracking-[-.005em]">
                    {u.name ?? u.email}
                  </span>
                  {!u.active && (
                    <span className="mono-cap rounded-full bg-warm2 px-2 py-0.5 text-[9px] font-semibold text-mute">
                      inactive
                    </span>
                  )}
                </div>
                <div className="mono-cap mt-0.5 text-[10px] tracking-[.04em] text-mute">{u.email}</div>
              </div>
              <div className="text-[13px] capitalize text-ink2">{u.role.replace("_", " ")}</div>
              <div className="flex flex-wrap gap-1">
                {u.groups.length === 0 ? (
                  <span className="text-[12px] text-mute">—</span>
                ) : (
                  u.groups.map((g) => (
                    <span
                      key={g.id}
                      className="rounded-full bg-warm2 px-2 py-0.5 font-mono text-[10px] font-semibold text-ink2"
                    >
                      {g.name}
                    </span>
                  ))
                )}
              </div>
              <div className="text-center text-[12px]">
                {u.has_password ? (
                  <span className="text-state-ok">set</span>
                ) : (
                  <span className="text-state-warn">not set</span>
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  onClick={() => setMode({ kind: "editing", user: u })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  Edit
                </button>
                <button
                  onClick={() => setMode({ kind: "resetting", user: u })}
                  className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
                >
                  {u.has_password ? "Reset password" : "Set password"}
                </button>
                <ToggleSwitch
                  enabled={u.active}
                  busy={busy === u.id}
                  onClick={() => onToggleActive(u)}
                />
              </div>
            </Row>
          ))
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
          {error}
        </div>
      )}

      {mode.kind === "creating" && (
        <UserFormDialog
          title="New user"
          submitLabel="Create"
          groups={groups}
          modules={modules}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(out) =>
            onCreate({
              email: out.email,
              name: out.name,
              role: out.role,
              password: out.password,
              groupIds: out.groupIds,
            })
          }
          busy={busy === "create"}
          allowEmail
          allowPassword
        />
      )}
      {mode.kind === "editing" && (
        <UserFormDialog
          title="Edit user"
          submitLabel="Save"
          groups={groups}
          modules={modules}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(out) =>
            onUpdate(mode.user, {
              name: out.name,
              role: out.role,
              groupIds: out.groupIds,
            })
          }
          busy={busy === mode.user.id}
          initial={{
            email: mode.user.email,
            name: mode.user.name ?? "",
            role: mode.user.role,
            password: "",
            groupIds: mode.user.groups.map((g) => g.id),
          }}
        />
      )}
      {mode.kind === "resetting" && (
        <ResetPasswordDialog
          user={mode.user}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(pw) => onResetPassword(mode.user, pw)}
          busy={busy === mode.user.id}
        />
      )}
    </>
  );
}

function ToggleSwitch({
  enabled,
  busy,
  onClick,
}: {
  enabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={enabled ? "Click to deactivate" : "Click to reactivate"}
      className={cn(
        "relative h-[22px] w-[40px] flex-shrink-0 rounded-full transition disabled:opacity-50",
        enabled ? "bg-grad" : "bg-rule2",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all",
          enabled ? "left-[20px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Row({
  hdr = false,
  dimmed = false,
  children,
}: {
  hdr?: boolean;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-4 px-[22px] border-b border-rule last:border-b-0 transition",
        hdr
          ? "mono-cap py-3 text-[9.5px] font-semibold tracking-[.12em] text-mute bg-warm"
          : "py-3.5",
        dimmed && !hdr && "bg-warm/40",
      )}
      style={{ gridTemplateColumns: "2.2fr 110px 1.8fr 110px 250px" }}
    >
      {children}
    </div>
  );
}

function DialogShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="my-12 w-full max-w-[560px] rounded-2xl border border-rule bg-paper p-7 shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif text-[26px] font-normal leading-tight tracking-[-.01em]">
              {title}
            </h2>
            {subtitle && <p className="mt-1 text-[13px] leading-[1.5] text-mute">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-mute hover:text-ink" aria-label="Close">
            <Icon name="plus" size={18} strokeWidth={2} className="rotate-45" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface UserFormState {
  email: string;
  name: string;
  role: string;
  password: string;
  groupIds: string[];
}

function UserFormDialog({
  title,
  submitLabel,
  initial,
  groups,
  modules,
  onClose,
  onSubmit,
  busy,
  allowEmail,
  allowPassword,
}: {
  title: string;
  submitLabel: string;
  initial?: UserFormState;
  groups: UserGroupSummary[];
  modules: ModuleAccess[];
  onClose: () => void;
  onSubmit: (out: UserFormState) => void;
  busy: boolean;
  allowEmail?: boolean;
  allowPassword?: boolean;
}) {
  const [email, setEmail] = useState(initial?.email ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "advisor");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [groupIds, setGroupIds] = useState<string[]>(initial?.groupIds ?? []);

  function toggleGroup(id: string) {
    setGroupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  // Union of every selected group's permissions — what the user will actually
  // be able to do once saved. Recomputes live as boxes are toggled.
  const effectivePerms = useMemo(() => {
    const out = new Set<string>();
    for (const id of groupIds) {
      const g = groups.find((x) => x.id === id);
      if (!g) continue;
      for (const p of g.permissions) out.add(p);
    }
    return out;
  }, [groupIds, groups]);

  return (
    <DialogShell title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (allowEmail && !email.trim()) return;
          onSubmit({ email: email.trim(), name: name.trim(), role, password, groupIds });
        }}
        className="space-y-4"
      >
        <Field label="Email" required={allowEmail}>
          <input
            className={inputCls}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!allowEmail}
            placeholder="user@company.com"
            autoFocus={allowEmail}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
            />
          </Field>
          <Field label="Role tag">
            <select
              className={inputCls}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {allowPassword && (
          <Field label="Initial password">
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to invite without a password"
            />
          </Field>
        )}
        <Field label="Groups">
          <div className="grid max-h-[180px] grid-cols-2 gap-2 overflow-y-auto rounded-[10px] border border-rule bg-warm/40 p-3">
            {groups.length === 0 ? (
              <div className="col-span-2 text-[12px] text-mute">
                No groups yet — create one first on{" "}
                <a href="/admin/groups" className="font-semibold text-brand-violet hover:underline">Admin · Groups</a>.
              </div>
            ) : (
              groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={groupIds.includes(g.id)}
                    onChange={() => toggleGroup(g.id)}
                  />
                  <span>{g.name}</span>
                </label>
              ))
            )}
          </div>
        </Field>

        <EffectiveAccess modules={modules} permissions={effectivePerms} />
        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function generateStrongPassword(length = 14): string {
  // Mix uppercase, lowercase, digits, and a small symbol set so the result
  // satisfies common password policies without being painful to type.
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // skip I/O for legibility
  const lower = "abcdefghijkmnpqrstuvwxyz";   // skip l/o
  const digits = "23456789";                   // skip 0/1
  const symbols = "!@#$%^&*";
  const all = upper + lower + digits + symbols;
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  // Guarantee at least one of each class.
  const required = [
    upper[buf[0]! % upper.length]!,
    lower[buf[1]! % lower.length]!,
    digits[buf[2]! % digits.length]!,
    symbols[buf[3]! % symbols.length]!,
  ];
  const rest = Array.from(buf.slice(4)).map((n) => all[n % all.length]!);
  const chars = [...required, ...rest];
  // Fisher-Yates shuffle so required chars aren't always at the front.
  const shuffleBuf = new Uint32Array(chars.length);
  crypto.getRandomValues(shuffleBuf);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBuf[i]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

function ResetPasswordDialog({
  user,
  onClose,
  onSubmit,
  busy,
}: {
  user: AdminUser;
  onClose: () => void;
  onSubmit: (password: string) => void;
  busy: boolean;
}) {
  const isInitial = !user.has_password;
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function onGenerate() {
    const next = generateStrongPassword();
    setPw(next);
    setConfirm(next);
    setShow(true);
    setErr(null);
    setCopied(false);
  }

  async function onCopy() {
    if (!pw) return;
    try {
      await navigator.clipboard.writeText(pw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr("Couldn't copy. Select and copy manually.");
    }
  }

  return (
    <DialogShell
      title={
        isInitial
          ? `Set initial password for ${user.name ?? user.email}`
          : `Reset password for ${user.name ?? user.email}`
      }
      subtitle={
        isInitial
          ? "Share the password with the user securely. They will be able to sign in immediately."
          : "The user is signed out of all sessions when their password changes."
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setErr(null);
          if (pw.length < 8) return setErr("Password must be at least 8 characters.");
          if (pw !== confirm) return setErr("Passwords don't match.");
          onSubmit(pw);
        }}
        className="space-y-4"
      >
        <div>
          <div className="mono-cap mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-[.12em] text-mute">
            <span>
              New password <span className="ml-1 text-brand-magenta">*</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onGenerate}
                className="rounded text-[9.5px] font-semibold tracking-[.12em] text-brand-violet hover:underline"
              >
                GENERATE STRONG
              </button>
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="rounded text-[9.5px] font-semibold tracking-[.12em] text-mute hover:text-ink"
              >
                {show ? "HIDE" : "SHOW"}
              </button>
            </div>
          </div>
          <div className="relative">
            <input
              className={`${inputCls} pr-[88px] font-mono`}
              type={show ? "text" : "password"}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoFocus
            />
            {pw && (
              <button
                type="button"
                onClick={onCopy}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md border border-rule bg-paper px-2 py-1 text-[10px] font-semibold tracking-[.06em] text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                {copied ? "COPIED" : "COPY"}
              </button>
            )}
          </div>
        </div>

        <Field label="Confirm password" required>
          <input
            className={inputCls}
            type={show ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>

        {err && (
          <div className="rounded-lg border border-state-warn/30 bg-state-warn/10 px-3 py-2 text-[12px] text-state-warn">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : isInitial ? "Set password" : "Reset password"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

const inputCls =
  "w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 text-[13.5px] text-ink placeholder:text-hint focus:border-brand-violet focus:outline-none focus:ring-2 focus:ring-brand-violet/20 disabled:bg-warm/40 disabled:text-mute";

function EffectiveAccess({
  modules,
  permissions,
}: {
  modules: ModuleAccess[];
  permissions: Set<string>;
}) {
  const rows = modules
    .map((m) => {
      const granted = m.levels.filter((lvl) => permissions.has(lvl.permission));
      return granted.length > 0 ? { module: m, granted } : null;
    })
    .filter(Boolean) as { module: ModuleAccess; granted: ModuleAccess["levels"] }[];

  return (
    <div className="rounded-[10px] border border-rule bg-grad-soft p-3">
      <div className="mono-cap mb-2 flex items-center justify-between text-[10px] font-semibold tracking-[.12em] text-mute">
        <span>Effective access · what this user will be able to do</span>
        <span>{permissions.size} permission{permissions.size === 1 ? "" : "s"}</span>
      </div>
      {rows.length === 0 ? (
        <div className="text-[12.5px] text-mute">
          No module access yet. Tick at least one group above.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rows.map(({ module, granted }) => (
            <span
              key={module.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand-violet/30 bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2"
            >
              <span className="text-ink">{module.label}</span>
              <span className="text-mute">·</span>
              <span className="font-mono text-[10px] uppercase tracking-[.04em] text-brand-violet">
                {granted.map((lvl) => lvl.label).join(" + ")}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mono-cap mb-1.5 block text-[10px] font-semibold tracking-[.12em] text-mute">
        {label}
        {required && <span className="ml-1 text-brand-magenta">*</span>}
      </span>
      {children}
    </label>
  );
}
