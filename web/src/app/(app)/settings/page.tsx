import { ComingSoon } from "@/components/shell/ComingSoon";

export default function SettingsPage() {
  return (
    <ComingSoon
      title="Settings"
      icon="settings"
      blurb="Tenant config, RBAC, channel integrations (WhatsApp, Exotel, Zoom), approval policy table, model gateway routing, agent identity registry."
      phase="Phase 3 · Hardening"
    />
  );
}
