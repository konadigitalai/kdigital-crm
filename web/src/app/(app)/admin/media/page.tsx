import { Topbar } from "@/components/shell/Topbar";
import { getCurrentUser } from "@/lib/api";
import { requirePagePermission } from "@/lib/guards";
import { MediaLibrary } from "@/components/media/MediaLibrary";

export default async function AdminMediaPage() {
  await requirePagePermission("media.read");
  const me = await getCurrentUser();
  const canUpload = me?.permissions.includes("media.upload") ?? false;
  const canManage = me?.permissions.includes("media.manage") ?? false;

  return (
    <>
      <Topbar
        crumb={
          <>Edify CRM <span className="text-hint">/</span> Admin <span className="text-hint">/</span>{" "}
          <b className="font-semibold text-ink">Media library</b></>
        }
        status="Storage"
      />
      <div className="px-6 pb-8 pt-6">
        <MediaLibrary canUpload={canUpload} canManage={canManage} />
      </div>
    </>
  );
}
