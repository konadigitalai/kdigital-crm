import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/shell/Topbar";
import { getAccount } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { AccountContactsPanel } from "@/components/b2b/AccountContactsPanel";
import { Pill, formatMoney, humanise } from "@/components/admin/formKit";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ partyId: string }>;
}) {
  await requirePagePermission("accounts.read");
  const { partyId } = await params;

  let account;
  try {
    account = await getAccount(partyId);
  } catch {
    notFound();
  }
  if (!account) notFound();

  const opportunities = account.opportunities ?? [];
  const requisitions = account.requisitions ?? [];
  const openDeals = opportunities.filter((o) => !o.stage.startsWith("closed"));

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/accounts" className="cursor-pointer hover:text-ink">Accounts</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">{account.name}</b>
          </>
        }
        status="Synced"
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-serif text-[36px] font-normal leading-none tracking-[-.01em]">{account.name}</h1>
            <span className="font-mono text-[12px] text-hint">{account.accountNumber}</span>
            <Pill tone={account.accountType === "hiring_partner" ? "brand" : "info"}>
              {humanise(account.accountType)}
            </Pill>
            {account.rating && <Pill tone="warn">{account.rating}</Pill>}
            {account.status !== "active" && <Pill>{humanise(account.status)}</Pill>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-[13px] text-mute">
            {account.industry && <span>{account.industry}</span>}
            {account.website && (
              <a href={account.website} target="_blank" rel="noreferrer" className="hover:text-brand-violet">
                {account.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {account.city && <span>{account.city}</span>}
            {account.ownerName && <span>Owner · {account.ownerName}</span>}
          </div>
          {account.description && (
            <p className="mt-3 max-w-[720px] text-[13.5px] leading-[1.6] text-ink2">{account.description}</p>
          )}
        </div>

        <div className="mb-7 grid grid-cols-4 gap-4">
          <Stat label="Open pipeline" value={formatMoney(account.openPipelineValue, account.currency)}
                sub={`${openDeals.length} open deal${openDeals.length === 1 ? "" : "s"}`} />
          <Stat label="Contacts" value={String(account.contactCount)} sub="currently affiliated" />
          <Stat label="Open roles" value={String(account.openRequisitionCount)} sub="requisitions" />
          <Stat label="Annual revenue" value={formatMoney(account.annualRevenue, account.currency)} sub="reported" />
        </div>

        <div className="grid grid-cols-2 gap-6">
          <AccountContactsPanel accountPartyId={account.partyId} initial={account.contacts ?? []} />

          <div className="space-y-6">
            <Panel title="Opportunities" count={opportunities.length} href="/opportunities">
              {opportunities.length === 0 ? (
                <Empty>No deals against this account yet.</Empty>
              ) : opportunities.map((o) => (
                <div key={o.workItemId} className="flex items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{o.name ?? o.number}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mute">
                      <span className="font-mono">{o.number}</span>
                      <Pill tone={o.stage === "closed_won" ? "good" : o.stage === "closed_lost" ? "bad" : "info"}>
                        {humanise(o.stage)}
                      </Pill>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[13px]">{formatMoney(o.value, o.currency)}</div>
                    {o.expectedCloseDate && (
                      <div className="text-[11px] text-mute">closes {o.expectedCloseDate}</div>
                    )}
                  </div>
                </div>
              ))}
            </Panel>

            <Panel title="Requisitions" count={requisitions.length} href="/staffing/requisitions">
              {requisitions.length === 0 ? (
                <Empty>
                  {account.accountType === "hiring_partner"
                    ? "No open roles yet."
                    : "Mark this account a hiring partner to raise requisitions against it."}
                </Empty>
              ) : requisitions.map((r) => (
                <div key={r.id} className="flex items-center gap-3 border-b border-rule px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{r.jobTitle}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-mute">
                      <span className="font-mono">{r.number}</span>
                      <Pill tone={r.status === "open" ? "good" : "neutral"}>{humanise(r.status)}</Pill>
                    </div>
                  </div>
                  <div className="text-right text-[12px] text-mute">
                    <div>{r.openings} opening{r.openings === 1 ? "" : "s"}</div>
                    <div>{r.applicationCount} applicant{r.applicationCount === 1 ? "" : "s"}</div>
                  </div>
                </div>
              ))}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[14px] border border-rule bg-paper p-4">
      <div className="mono-cap text-[9.5px] font-semibold tracking-[.12em] text-mute">{label}</div>
      <div className="mt-1.5 font-mono text-[22px] leading-none tracking-[-.01em]">{value}</div>
      {sub && <div className="mt-1.5 text-[11.5px] text-mute">{sub}</div>}
    </div>
  );
}

function Panel({
  title, count, href, children,
}: {
  title: string; count: number; href?: string; children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-rule bg-paper">
      <header className="flex items-center justify-between border-b border-rule bg-warm px-4 py-3">
        <h2 className="mono-cap text-[10px] font-semibold tracking-[.12em] text-mute">
          {title} {count > 0 && <span className="text-hint">({count})</span>}
        </h2>
        {href && (
          <Link href={href} className="text-[11.5px] font-semibold text-brand-violet hover:underline">
            View all
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-[12.5px] text-mute">{children}</div>;
}
