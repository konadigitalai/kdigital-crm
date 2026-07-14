import { Topbar } from "@/components/shell/Topbar";
import { getCatalog, getCurrentUser, getTwConversations } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { InboxShell } from "@/components/inbox/InboxShell";

export default async function InboxPage() {
  await requirePagePermission("messaging.read");
  const [conversations, me, catalog] = await Promise.all([
    getTwConversations(),
    getCurrentUser(),
    // Feeds the inbox's ADVISOR filter pill. Failing the whole page over a
    // dropdown's options would be a bad trade — an empty list just means the
    // pill only offers "All".
    getCatalog().catch(() => null),
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
          advisors={(catalog?.advisors ?? []).map((a) => ({ id: a.id, name: a.name }))}
          canSend={canSend}
          canPromote={canPromote}
          canUpload={canUpload}
          canAddToLibrary={canManage}
        />
      </div>
    </>
  );
}
