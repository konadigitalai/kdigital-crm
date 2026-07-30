// Learner-portal route group.
//
// Separate from (app) on purpose. The CRM's AppShell fetches /agents/recent
// and /summary up front; a learner holds neither permission, so rendering
// them inside that shell 403s the page before any content appears.
//
// Access is gated on lms.read.self. Someone with a valid session but no LMS
// permission gets a plain explanation rather than a redirect loop.

import { redirect } from "next/navigation";
import { getCurrentUser, getLmsMe, getLmsWork } from "@/lib/api";
import { LearnShell } from "@/components/learn/LearnShell";
import type { LmsMe } from "@/lib/types";

export default async function LearnLayout({ children }: { children: React.ReactNode }) {
  const me = await getCurrentUser();
  if (!me) redirect("/auth/login");

  const perms = new Set(me.permissions);
  const canLearn = perms.has("lms.read.self");
  const canAdmin = perms.has("lms.content.manage");

  if (!canLearn && !canAdmin) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f7f5f0] px-6">
        <div className="max-w-md rounded-2xl border border-black/5 bg-white p-8 text-center shadow-sm">
          <h1 className="font-serif text-2xl">No learning access</h1>
          <p className="mt-3 text-sm text-ink/60">
            This account isn&rsquo;t enrolled in the academy. If you think that&rsquo;s wrong,
            ask your advisor to check your batch assignment.
          </p>
          <a href="/" className="mt-6 inline-block text-sm font-medium text-indigo-700 hover:underline">
            Back to the CRM
          </a>
        </div>
      </div>
    );
  }

  // An LMS admin who isn't also a learner has no /lms/me record — that's
  // expected, not an error, so the header falls back to their CRM identity.
  let learner: LmsMe | null = null;
  let workBadge: number | undefined;
  if (canLearn) {
    const [m, work] = await Promise.all([
      getLmsMe().catch(() => null),
      getLmsWork().catch(() => null),
    ]);
    learner = m;
    workBadge = work?.stats.dueThisWeek || undefined;
  }
  if (!learner) {
    learner = {
      partyId: "", name: me.name, email: me.email, learnerNumber: null,
      learnerStatus: null, activeBatches: 0, completedBatches: 0,
    };
  }

  return (
    <LearnShell
      me={learner}
      canAdmin={canAdmin}
      badges={{ learning: learner.activeBatches || undefined, work: workBadge }}
    >
      {children}
    </LearnShell>
  );
}
