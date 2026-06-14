import { LoginForm } from "@/components/auth/LoginForm";
import { Icon } from "@/components/ui/Icon";

export const metadata = { title: "Sign in · Edify CRM" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <div
      className="grid min-h-screen bg-canvas lg:grid-cols-[1.05fr_1fr]"
      style={{ height: "100vh", overflow: "auto" }}
    >
      {/* ── Brand panel ───────────────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden bg-grad lg:flex lg:flex-col lg:justify-between lg:p-14 text-white">
        <div
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% 80%, rgba(255,255,255,.35) 0, transparent 45%), radial-gradient(circle at 80% 20%, rgba(255,255,255,.25) 0, transparent 40%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[.07]"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,.9) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        <header className="relative z-[1] flex items-center gap-3">
          <div className="grid h-[42px] w-[42px] place-items-center rounded-[12px] bg-white/15 backdrop-blur-sm font-serif text-[22px] font-normal">
            E
          </div>
          <div>
            <div className="text-[16px] font-bold tracking-tight">Edify CRM</div>
            <div className="font-mono text-[10px] tracking-[.14em] uppercase text-white/70">
              Agentic Operating System
            </div>
          </div>
        </header>

        <div className="relative z-[1] max-w-[480px]">
          <h1 className="font-serif text-[44px] font-normal leading-[1.05] tracking-[-.015em]">
            Where every lead, case, and learner runs through the same intelligent fabric.
          </h1>
          <p className="mt-6 max-w-[440px] text-[14px] leading-[1.7] text-white/85">
            Sign in to manage leads, run agents, and orchestrate your sales and service teams.
          </p>

          <div className="mt-10 grid grid-cols-3 gap-3">
            <Pill icon="users" label="Leads" />
            <Pill icon="chart" label="Pipeline" />
            <Pill icon="inbox" label="Cases" />
            <Pill icon="stamp" label="Learners" />
            <Pill icon="agents-grid" label="Agents" />
            <Pill icon="settings" label="Admin" />
          </div>
        </div>

        <footer className="relative z-[1] flex items-center justify-between text-[11.5px] text-white/70">
          {/* <span className="font-mono tracking-[.04em]">v2.6 · MCP connected</span> */}
          <span>© Digital Edify</span>
        </footer>
      </aside>

      {/* ── Form panel ────────────────────────────────────────────────── */}
      <section className="relative flex items-center justify-center px-6 py-10">
        <div
          className="absolute inset-0 -z-[1] opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(rgba(14,10,20,.05) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            maskImage:
              "radial-gradient(ellipse at 50% 40%, #000 40%, transparent 80%)",
            WebkitMaskImage:
              "radial-gradient(ellipse at 50% 40%, #000 40%, transparent 80%)",
          }}
        />

        <div className="w-full max-w-[420px]">
          {/* Mobile logo (hidden on lg) */}
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="grid h-[34px] w-[34px] place-items-center rounded-[9px] bg-grad text-white font-bold">
              E
            </div>
            <div>
              <div className="text-[15px] font-bold tracking-tight">Edify CRM</div>
              <div className="font-mono text-[10px] tracking-[.04em] text-mute">
                Agentic CRM
              </div>
            </div>
          </div>

          <div className="mb-8">
            <h2 className="font-serif text-[36px] font-normal leading-tight tracking-[-.01em]">
              Welcome back
            </h2>
            <p className="mt-2 text-[13.5px] text-mute">
              Sign in with your work email to continue.
            </p>
          </div>

          <div className="rounded-2xl border border-rule bg-paper p-7 shadow-card">
            <LoginForm next={next ?? "/"} />
          </div>

          <p className="mt-6 text-center text-[11.5px] text-mute">
            Trouble signing in? Contact your CRM administrator.
          </p>
        </div>
      </section>
    </div>
  );
}

function Pill({
  icon,
  label,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-white/15 bg-white/10 px-3 py-2 backdrop-blur-sm">
      <Icon name={icon} size={14} strokeWidth={1.8} className="text-white/85" />
      <span className="text-[12px] font-semibold tracking-tight">{label}</span>
    </div>
  );
}
