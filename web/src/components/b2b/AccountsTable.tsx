"use client";

// B2B accounts — the organisations that buy training and hire graduates.
//
// An account is a satellite of an organisation party, so the name lives on the
// party and the commercial attributes live here. `hiring_partner` is a first-
// class account type rather than a flag, because the staffing module keys off
// it: a requisition can only be raised against an account.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { createAccount, updateAccount } from "@/lib/api";
import type { Account, AccountInput, AccountRating, AccountStatus, AccountType } from "@/lib/types";
import { FilterBar } from "@/components/filter/FilterBar";
import { useFilter } from "@/components/filter/useFilter";
import type { FilterField } from "@/components/filter/types";
import {
  DialogShell, EmptyRow, ErrorNote, Field, GridRow, Pill,
  distinct, formatMoney, humanise, inputCls,
} from "@/components/admin/formKit";

const COLS = "2.2fr 1.3fr 130px 120px 150px 110px 120px";

const ACCOUNT_TYPES: AccountType[] = ["prospect", "client", "hiring_partner", "partner", "vendor"];
const STATUSES: AccountStatus[] = ["active", "inactive", "churned"];
const RATINGS: AccountRating[] = ["hot", "warm", "cold"];

const TYPE_TONE: Record<AccountType, "good" | "info" | "brand" | "neutral"> = {
  client: "good",
  hiring_partner: "brand",
  partner: "info",
  prospect: "neutral",
  vendor: "neutral",
};

const RATING_TONE: Record<AccountRating, "bad" | "warn" | "info"> = {
  hot: "bad",       // hot reads as the urgent colour, deliberately
  warm: "warn",
  cold: "info",
};

function buildFields(rows: Account[]): FilterField[] {
  const industries = distinct(rows, (a) => a.industry);
  return [
    { key: "name",     label: "Account",  type: "text", get: (a: Account) => a.name },
    { key: "number",   label: "Number",   type: "text", get: (a: Account) => a.accountNumber },
    { key: "type",     label: "Type",     type: "enum", options: ACCOUNT_TYPES.map((t) => ({ value: t, label: humanise(t) })), get: (a: Account) => a.accountType },
    { key: "industry", label: "Industry", type: "enum", options: industries.map((i) => ({ value: i, label: i })), get: (a: Account) => a.industry },
    { key: "status",   label: "Status",   type: "enum", options: STATUSES.map((s) => ({ value: s, label: humanise(s) })), get: (a: Account) => a.status },
    { key: "rating",   label: "Rating",   type: "enum", options: RATINGS.map((r) => ({ value: r, label: humanise(r) })), get: (a: Account) => a.rating },
    { key: "owner",    label: "Owner",    type: "text", get: (a: Account) => a.ownerName },
    { key: "contacts", label: "Contacts", type: "number", get: (a: Account) => a.contactCount },
    { key: "openDeals", label: "Open deals", type: "number", get: (a: Account) => a.openOpportunityCount },
    { key: "pipeline", label: "Pipeline value", type: "number", get: (a: Account) => Number(a.openPipelineValue ?? 0) },
    { key: "openReqs", label: "Open requisitions", type: "number", get: (a: Account) => a.openRequisitionCount },
  ];
}

type Mode = { kind: "idle" } | { kind: "creating" } | { kind: "editing"; account: Account };

export function AccountsTable({ initial }: { initial: Account[] }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields = useMemo(() => buildFields(accounts), [accounts]);
  const [filtered, filterState, setFilterState] = useFilter(accounts, fields);

  const sortAccounts = (a: Account, b: Account) => {
    if ((a.status === "active") !== (b.status === "active")) return a.status === "active" ? -1 : 1;
    return a.name.localeCompare(b.name);
  };

  async function onCreate(input: AccountInput) {
    setBusy("create"); setError(null);
    try {
      const created = await createAccount(input);
      setAccounts((all) => [...all, created].sort(sortAccounts));
      setMode({ kind: "idle" });
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  async function onUpdate(a: Account, patch: AccountInput) {
    setBusy(a.partyId); setError(null);
    try {
      const updated = await updateAccount(a.partyId, patch);
      setAccounts((all) => all.map((x) => (x.partyId === a.partyId ? updated : x)).sort(sortAccounts));
      setMode({ kind: "idle" });
      router.refresh();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }

  const totalPipeline = accounts.reduce((sum, a) => sum + Number(a.openPipelineValue ?? 0), 0);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13px] text-mute">
          {accounts.length} account{accounts.length === 1 ? "" : "s"}
          {" · "}{accounts.filter((a) => a.accountType === "hiring_partner").length} hiring partners
          {totalPipeline > 0 && <> · {formatMoney(totalPipeline)} open pipeline</>}
        </div>
        <button onClick={() => setMode({ kind: "creating" })} className="btn-grad">
          <Icon name="plus" size={14} strokeWidth={2.2} /> New account
        </button>
      </div>

      <div className="mb-4 rounded-[14px] border border-rule bg-paper p-3">
        <FilterBar
          fields={fields}
          state={filterState}
          onChange={setFilterState}
          placeholder="Filter accounts by field…"
          totalRows={accounts.length}
          filteredRows={filtered.length}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-rule bg-paper">
        <GridRow cols={COLS} hdr>
          <div>Account</div>
          <div>Industry</div>
          <div>Type</div>
          <div className="text-center">Contacts</div>
          <div className="text-right">Open pipeline</div>
          <div className="text-center">Reqs</div>
          <div className="text-right">Actions</div>
        </GridRow>

        {filtered.length === 0 ? (
          <EmptyRow>
            {accounts.length === 0
              ? "No accounts yet — add the first organisation you sell to or hire with."
              : "No accounts match the current filter."}
          </EmptyRow>
        ) : filtered.map((a) => (
          <GridRow key={a.partyId} cols={COLS} dimmed={a.status !== "active"}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/accounts/${a.partyId}`}
                  className="text-[14px] font-semibold tracking-[-.005em] hover:text-brand-violet"
                >
                  {a.name}
                </Link>
                <span className="font-mono text-[10.5px] text-hint">{a.accountNumber}</span>
                {a.rating && <Pill tone={RATING_TONE[a.rating]}>{a.rating}</Pill>}
                {a.status !== "active" && <Pill>{humanise(a.status)}</Pill>}
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-mute">
                {a.website ?? a.email ?? (a.ownerName ? `Owner · ${a.ownerName}` : "—")}
              </div>
            </div>

            <div className="min-w-0 truncate text-[13px] text-ink2">
              {a.industry ?? <span className="text-mute">—</span>}
            </div>

            <div><Pill tone={TYPE_TONE[a.accountType]}>{humanise(a.accountType)}</Pill></div>

            <div className="text-center text-[13px]" title="Currently affiliated people">
              {a.contactCount > 0 ? a.contactCount : <span className="text-mute">—</span>}
            </div>

            <div className="text-right font-mono text-[13px] text-ink2">
              {a.openOpportunityCount > 0
                ? (
                  <>
                    {formatMoney(a.openPipelineValue, a.currency)}
                    <div className="text-[11px] text-mute">
                      {a.openOpportunityCount} open deal{a.openOpportunityCount === 1 ? "" : "s"}
                    </div>
                  </>
                )
                : <span className="text-mute">—</span>}
            </div>

            <div className="text-center text-[13px]">
              {a.openRequisitionCount > 0
                ? <Pill tone="brand">{a.openRequisitionCount} open</Pill>
                : <span className="text-mute">—</span>}
            </div>

            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setMode({ kind: "editing", account: a })}
                className="rounded-md border border-rule bg-paper px-2.5 py-1 text-[11.5px] font-semibold text-ink2 hover:border-brand-violet hover:text-brand-violet"
              >
                Edit
              </button>
            </div>
          </GridRow>
        ))}
      </div>

      <ErrorNote message={error} />

      {mode.kind === "creating" && (
        <AccountFormDialog
          title="New account"
          submitLabel="Create"
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={onCreate}
          busy={busy === "create"}
        />
      )}
      {mode.kind === "editing" && (
        <AccountFormDialog
          title={mode.account.name}
          submitLabel="Save"
          initial={mode.account}
          onClose={() => setMode({ kind: "idle" })}
          onSubmit={(patch) => onUpdate(mode.account, patch)}
          busy={busy === mode.account.partyId}
        />
      )}
    </>
  );
}

function AccountFormDialog({
  title, submitLabel, initial, onClose, onSubmit, busy,
}: {
  title: string; submitLabel: string; initial?: Account;
  onClose: () => void; onSubmit: (input: AccountInput) => void; busy: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [accountType, setAccountType] = useState<AccountType>(initial?.accountType ?? "prospect");
  const [industry, setIndustry] = useState(initial?.industry ?? "");
  const [ownership, setOwnership] = useState(initial?.ownership ?? "");
  const [website, setWebsite] = useState(initial?.website ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [annualRevenue, setAnnualRevenue] = useState(initial?.annualRevenue ?? "");
  const [rating, setRating] = useState<AccountRating | "">(initial?.rating ?? "");
  const [status, setStatus] = useState<AccountStatus>(initial?.status ?? "active");
  const [description, setDescription] = useState(initial?.description ?? "");

  return (
    <DialogShell
      title={title}
      wide
      subtitle="An organisation you sell training to, hire graduates with, or both."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit({
            name: name.trim(),
            accountType,
            industry: industry.trim() || null,
            ownership: ownership.trim() || null,
            website: website.trim() || null,
            email: email.trim() || null,
            phone: phone.trim() || null,
            city: city.trim() || null,
            annualRevenue: String(annualRevenue).trim() || null,
            rating: rating || null,
            status,
            description: description.trim() || null,
          });
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-3 gap-4">
          <Field label="Account name" required>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Acme Technologies" />
          </Field>
          <Field
            label="Type"
            hint={accountType === "hiring_partner" ? "Requisitions can be raised against this account." : undefined}
          >
            <select className={inputCls} value={accountType} onChange={(e) => setAccountType(e.target.value as AccountType)}>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{humanise(t)}</option>)}
            </select>
          </Field>
          <Field label="Industry">
            <input className={inputCls} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Technology" />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Website">
            <input className={inputCls} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
          </Field>
          <Field label="Primary email">
            <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Primary phone">
            <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Field label="City">
            <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="Ownership">
            <input className={inputCls} value={ownership} onChange={(e) => setOwnership(e.target.value)} placeholder="Public / Private" />
          </Field>
          <Field label="Annual revenue (₹)">
            <input className={inputCls} value={annualRevenue ?? ""} onChange={(e) => setAnnualRevenue(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Rating">
            <select className={inputCls} value={rating} onChange={(e) => setRating(e.target.value as AccountRating | "")}>
              <option value="">—</option>
              {RATINGS.map((r) => <option key={r} value={r}>{humanise(r)}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Field label="Status">
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as AccountStatus)}>
              {STATUSES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Description">
          <textarea
            className={`${inputCls} min-h-[70px] resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What they buy, who they hire, anything the next person needs."
          />
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn-grad disabled:opacity-60">
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
