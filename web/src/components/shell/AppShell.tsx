import { AppShellClient } from "./AppShellClient";
import { getCurrentUser, getRecentRuns, getSummary } from "@/lib/api";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const [recentRuns, currentUser, summary] = await Promise.all([
    getRecentRuns(),
    getCurrentUser(),
    getSummary(),
  ]);
  return (
    <AppShellClient recentRuns={recentRuns} currentUser={currentUser} summary={summary}>
      {children}
    </AppShellClient>
  );
}
