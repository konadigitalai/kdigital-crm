import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/ui/Icon";
import {
  getCatalog, getCurrentUser, getSlackDeliveries, getSlackRules, getSlackShareTargets,
} from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { SlackRulesTable } from "@/components/admin/SlackRulesTable";
import { SlackShareTargetsCard } from "@/components/admin/SlackShareTargetsCard";
import { SlackWorkspaceCard } from "@/components/admin/SlackWorkspaceCard";
import Link from "next/link";

export default async function AdminSlackIntegrationPage() {
  await requirePagePermission("integrations.read");
  const [rules, deliveries, catalog, me, shareTargets] = await Promise.all([
    getSlackRules(),
    getSlackDeliveries(20),
    getCatalog(),
    getCurrentUser(),
    getSlackShareTargets(),
  ]);
  const canManage = me?.permissions.includes("integrations.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            <Link href="/settings" className="cursor-pointer hover:text-ink">Settings</Link>
            <span className="text-hint">/</span>
            <b className="font-semibold text-ink">Integrations · Slack</b>
          </>
        }
        status={canManage ? "Manage" : "Read-only"}
      />

      <div className="px-9 pb-[60px] pt-7">
        <div className="mb-[22px] flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-[40px] font-normal leading-none tracking-[-.01em]">Slack</h1>
            <p className="mt-2 max-w-[720px] text-[13.5px] text-mute">
              Two ways to push to Slack. <b className="text-ink">Automated rules</b> fire on
              events like "Lead created" or "Case closed". <b className="text-ink">Manual share targets</b>{" "}
              power the "Share to Slack" button on lead, learner, and case record pages — choose
              the channel and which fields to include.
            </p>
          </div>
        </div>

        <div className="mb-5 flex items-center gap-3 rounded-[14px] border border-rule2 bg-grad-soft p-[14px_18px] text-[13.5px] text-ink2">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-grad text-white">
            <Icon name="info" size={16} strokeWidth={1.8} />
          </span>
          <div>
            <b className="font-bold text-ink">Webhook URLs are secrets.</b>{" "}
            Slack revokes any URL it sees published. Paste them here only — never into git, screenshots, or shared docs.
          </div>
        </div>

        <h2 className="mb-3 mt-8 font-serif text-[24px] tracking-[-.005em]">Bot workspace</h2>
        <p className="mb-4 max-w-[720px] text-[13px] text-mute">
          Paste a Slack bot token to enable the dynamic "pick channel or person" flow on the
          "Share to Slack" button. Without a token the share button falls back to the pre-configured
          webhooks below.
        </p>

        <SlackWorkspaceCard canManage={canManage} />

        <h2 className="mb-3 mt-8 font-serif text-[24px] tracking-[-.005em]">Manual share targets</h2>
        <p className="mb-4 max-w-[720px] text-[13px] text-mute">
          Fallback webhooks per surface — used when no bot token is configured, and as a default
          suggestion inside the "Share to Slack" dialog.
        </p>

        <SlackShareTargetsCard
          initialTargets={shareTargets.targets}
          fields={shareTargets.fields}
          canManage={canManage}
        />

        <h2 className="mb-3 mt-10 font-serif text-[24px] tracking-[-.005em]">Automated rules</h2>
        <p className="mb-4 max-w-[720px] text-[13px] text-mute">
          Fire when something happens in the CRM. Pick the event, optionally set a JSON filter,
          and Slack posts to the channel tied to the webhook.
        </p>

        <SlackRulesTable
          initial={rules}
          deliveries={deliveries}
          eventTypes={catalog.slackEvents}
          canManage={canManage}
        />
      </div>
    </>
  );
}
