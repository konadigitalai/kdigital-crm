import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser, getTwConversations } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { InboxShell } from "@/components/inbox/InboxShell";

export default async function InboxPage() {
  await requirePagePermission("messaging.read");
  const [conversations, me] = await Promise.all([
    getTwConversations(),
    getCurrentUser(),
  ]);
  const canSend    = me?.permissions.includes("messaging.send") ?? false;
  const canPromote = me?.permissions.includes("leads.write") ?? false;
  const canUpload  = me?.permissions.includes("media.upload") ?? false;
  const canManage  = me?.permissions.includes("media.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={<>Edify CRM <span className="text-hint">/</span> <b className="font-semibold text-ink">Inbox</b></>}
        status={canSend ? "Twilio ready" : "Read-only"}
      />
      <div className="px-6 pb-6 pt-6">
        <InboxShell
          initialConversations={conversations}
          canSend={canSend}
          canPromote={canPromote}
          canUpload={canUpload}
          canAddToLibrary={canManage}
        />
      </div>
    </>
  );
}
