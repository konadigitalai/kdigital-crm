import Link from "next/link";
import { cn } from "@/lib/cn";

// Three views of one pipeline: the roles, the people, and the joins between
// them. A shared tab strip rather than three sidebar entries — they are one
// module and a recruiter moves between them constantly.

const TABS = [
  { key: "requisitions", label: "Requisitions", href: "/staffing/requisitions" },
  { key: "candidates",   label: "Candidates",   href: "/staffing/candidates" },
  { key: "applications", label: "Applications", href: "/staffing/applications" },
] as const;

export function StaffingTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav className="mb-5 flex items-center gap-1 border-b border-rule">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            "-mb-px border-b-2 px-3.5 py-2.5 text-[13px] font-semibold transition",
            t.key === active
              ? "border-brand-violet text-brand-violet"
              : "border-transparent text-mute hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
