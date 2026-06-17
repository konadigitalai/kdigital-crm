import { Topbar } from "@/components/shell/Topbar";
import {
  getCurrentUser, getUsers, getWaConfig, getWaConversations,
  getWaTags, getWaTemplates,
} from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { InboxShell } from "@/components/inbox/InboxShell";

// Server component — bulk parallel-fetch, hand a snapshot to the client
// component. The client polls /whatsapp/conversations on a timer for fresh
// data.
export default async function InboxPage() {
  await requirePagePermission("whatsapp.read");

  // getUsers requires users.manage today; tolerate failure since
  // assignment is degraded-but-functional without it (assign-to-self
  // still works for any logged-in advisor).
  const [me, conversations, tags, templates, config, users] = await Promise.all([
    getCurrentUser(),
    getWaConversations({ status: "open" }),
    getWaTags().catch(() => []),
    getWaTemplates().catch(() => []),
    getWaConfig().catch(() => null),
    getUsers().catch(() => []),
  ]);

  const canSend = me?.permissions.includes("whatsapp.send") ?? false;
  const canManageTags = me?.permissions.includes("whatsapp.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>
            Edify CRM <span className="text-hint">/</span>{" "}
            <b className="font-semibold text-ink">Inbox</b>
          </>
        }
        status={config?.status === "connected" ? "WhatsApp connected" : "WhatsApp not configured"}
      />

      <InboxShell
        initialConversations={conversations}
        tags={tags}
        templates={templates}
        users={users}
        currentUser={me}
        canSend={canSend}
        canManageTags={canManageTags}
        configStatus={config?.status ?? "disconnected"}
      />
    </>
  );
}
