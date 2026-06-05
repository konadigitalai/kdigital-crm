import { ComingSoon } from "@/components/shell/ComingSoon";

export default function DispatchPage() {
  return (
    <ComingSoon
      title="Dispatch"
      icon="doc"
      blurb="Bulk command box — fan out one intent across thousands of leads, with per-lead approval gates. Beta: still tuning the LangGraph planner for batch jobs."
      phase="Beta · Phase 1"
    />
  );
}
