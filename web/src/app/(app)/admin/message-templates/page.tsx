import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { MessageTemplatesLibrary } from "@/components/messages/MessageTemplatesLibrary";

export default async function AdminMessageTemplatesPage() {
  await requirePagePermission("messaging.read");
  const me = await getCurrentUser();
  // Creating/editing/deleting a canned reply is gated the same as sending —
  // matches the API (writes require messaging.send).
  const canManage = me?.permissions.includes("messaging.send") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>Edify CRM <span className="text-hint">/</span> Admin <span className="text-hint">/</span>{" "}
          <b className="font-semibold text-ink">Saved messages</b></>
        }
        status="Messaging"
      />
      <div className="px-6 pb-8 pt-6">
        <MessageTemplatesLibrary canManage={canManage} />
      </div>
    </>
  );
}
