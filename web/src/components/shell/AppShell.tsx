import { IconRail } from "./IconRail";
import { Sidebar } from "./Sidebar";
import { getCurrentUser, getRecentRuns, getSummary } from "@/lib/api";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const [recentRuns, currentUser, summary] = await Promise.all([
    getRecentRuns(),
    getCurrentUser(),
    getSummary(),
  ]);
  return (
    <div
      className="relative z-[1] grid h-screen"
      style={{ gridTemplateColumns: "66px 280px 1fr" }}
    >
      <IconRail currentUser={currentUser} summary={summary} />
      <Sidebar recentRuns={recentRuns} currentUser={currentUser} summary={summary} />
      <main className="relative overflow-y-auto">{children}</main>
    </div>
  );
}
