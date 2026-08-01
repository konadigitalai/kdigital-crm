"use client";

// LMS admin — build and edit the modules, lessons and coursework in one batch.
//
// Laid out as the LEARNER'S PLAYER, deliberately: a module list down the left,
// one thing open on the right. The previous screen was a stack of accordions
// where every lesson was a single cramped row whose only action was "Remove",
// so authoring meant deleting and re-adding to fix a typo, and nothing showed
// you what the lesson would actually look like.
//
// Two rules follow from mirroring the player:
//
//   * The right pane PREVIEWS first, then edits. If the video id is wrong you
//     see a dead embed here rather than hearing about it from a learner.
//   * Draft and disabled items are visibly dimmed in the sidebar, because the
//     question an admin is really asking is "what can they see right now".
//
// Every action awaits the API then router.refresh() — no optimistic updates.
// Content authoring is low-frequency, and a stale tree after a failed write is
// far more confusing than a 300ms wait.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createLmsModule, updateLmsModule, deleteLmsModule,
  createLmsResource, updateLmsResource, deleteLmsResource,
  createLmsCoursework, updateLmsCoursework, deleteLmsCoursework,
  updateLmsBatch, resolveVimeo, ApiError,
} from "@/lib/api";
import {
  hms, vimeoEmbedUrl, splitVimeoRef, RESOURCE_LABEL, COURSEWORK_CHIP, COURSEWORK_LABEL,
} from "@/lib/lmsUi";
import { batchStatusLabel } from "@/lib/batchStatus";
import { cn } from "@/lib/cn";
import type {
  LmsAdminBatch, LmsAdminContent, LmsAdminModule, LmsAdminResource,
  LmsAdminCoursework, ResourceKind, CourseworkType, VimeoLookup,
} from "@/lib/types";

const KINDS: ResourceKind[] = ["video", "recording", "note", "link", "document"];
const TYPES: CourseworkType[] = ["lab", "assignment", "assessment"];
const STATUSES = ["upcoming", "running", "completed", "cancelled"];

/** What's open in the right pane. */
type Sel =
  | { t: "batch" }
  | { t: "module"; id: string }
  | { t: "resource"; id: string }
  | { t: "coursework"; id: string }
  | { t: "newResource"; moduleId: string }
  | { t: "newCoursework"; moduleId: string };

/** Accepts whatever an admin pastes — a share link, a player link, or a bare
 *  id — and returns what we store.
 *
 *  Critically it KEEPS the privacy hash of an unlisted video:
 *  vimeo.com/1214797433/ab12cd34ef → "1214797433/ab12cd34ef". Dropping it (as
 *  this used to) leaves an embed that answers 403 with Vimeo's "because of its
 *  privacy settings" screen, which reads like an account problem and isn't. */
function vimeoRef(input: string): string {
  const s = input.trim();
  // player.vimeo.com/video/<id>?h=<hash>
  const player = s.match(/player\.vimeo\.com\/video\/(\d+)/i);
  if (player) {
    const h = s.match(/[?&]h=([0-9a-z]+)/i);
    return h ? `${player[1]}/${h[1]}` : player[1]!;
  }
  // vimeo.com/<id>[/<hash>]
  const share = s.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([0-9a-z]+))?/i);
  if (share) return share[2] ? `${share[1]}/${share[2]}` : share[1]!;
  // bare "<id>" or "<id>/<hash>"
  const bare = s.match(/^(\d+)(?:[/:]([0-9a-z]+))?$/i);
  if (bare) return bare[2] ? `${bare[1]}/${bare[2]}` : bare[1]!;
  return s;
}

/** ISO → the value <input type="datetime-local"> wants, in LOCAL time.
 *  Slicing the ISO string instead would silently shift every due date by the
 *  UTC offset each time a form was opened and saved. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

/** Seconds → minutes for the form, WITHOUT rounding to whole minutes. A 12:30
 *  video stored as 750s must come back as "12.5": round it to "13" and the
 *  form reads dirty the moment it loads, and every save nudges the length. */
const minutesOf = (seconds: number | null): string =>
  seconds ? String(Math.round((seconds / 60) * 100) / 100) : "";

/** Minutes → seconds, or null. Zero and junk become NULL rather than 0
 *  because module_resource_duration_check demands `> 0` — typing "0" into
 *  Length would otherwise come back as an unexplained 500. */
function secondsFrom(minutes: string): number | null {
  const n = Number(minutes.trim());
  if (!minutes.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 60);
}

/** The payload column module_resource_payload_check insists on for each kind.
 *  Blanking it is a constraint violation, so Save is blocked instead — an
 *  admin clearing a Vimeo ID should be told why, not handed a 500. */
function payloadFor(kind: ResourceKind): { label: string; required: boolean } {
  if (kind === "video" || kind === "recording") return { label: "a Vimeo ID", required: true };
  if (kind === "note") return { label: "note text", required: true };
  if (kind === "link") return { label: "a URL", required: true };
  return { label: "an uploaded file", required: false };
}

/** Compare a typed field against a stored numeric BY VALUE.
 *
 *  Postgres hands back `numeric` as a string — "100" saved comes back
 *  "100.00" — and minutes round-trip through seconds, so 12.5 comes back 13.
 *  A string compare would leave a form reading "Unsaved changes" immediately
 *  after a successful save, forever. */
function sameNumber(typed: string, stored: string | number | null): boolean {
  const a = typed.trim();
  const b = stored === null || stored === undefined ? "" : String(stored).trim();
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Number(a) === Number(b);
}

/** The Vimeo link field, which resolves what you pasted against Vimeo.
 *
 *  Admins copy the share link, because that is what a link is for. But an
 *  "Embed only" video is unplayable without its privacy hash, and Vimeo leaves
 *  that hash out of the share panel's Copy link field — it lives only in the
 *  `</>` embed snippet. Rather than train everyone to click a different button,
 *  the server looks the video up and fills the hash in.
 *
 *  Resolving also brings back the title and the real duration, so neither has
 *  to be typed. It fires on blur; if the server has no Vimeo token the field
 *  quietly stays manual rather than showing an error that reads like the paste
 *  was wrong. */
function VimeoField({
  value, onChange, onResolved,
}: {
  value: string;
  onChange: (v: string) => void;
  onResolved: (l: VimeoLookup) => void;
}) {
  const [state, setState] = useState<
    { t: "idle" } | { t: "loading" } | { t: "ok"; l: VimeoLookup } | { t: "err"; msg: string } | { t: "manual" }
  >({ t: "idle" });
  const lastResolved = useRef<string>("");
  // Named in the warning below — "add your domain" is useless without saying
  // which one. Read after mount; the server has no window.
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => setHost(window.location.host), []);

  const resolve = async (raw: string) => {
    const v = raw.trim();
    if (!v || v === lastResolved.current) return;
    lastResolved.current = v;
    setState({ t: "loading" });
    try {
      const l = await resolveVimeo(v);
      // Store the canonical ref — this is the string that actually plays.
      onChange(l.ref);
      lastResolved.current = l.ref;
      onResolved(l);
      setState({ t: "ok", l });
    } catch (err) {
      // 501 = no token on the server. Not the admin's problem and not an
      // error: fall back to manual entry with a hint about the embed code.
      if (err instanceof ApiError && err.status === 501) { setState({ t: "manual" }); return; }
      setState({
        t: "err",
        msg: err instanceof ApiError
          ? String((err.body as { error?: string })?.error ?? err.message)
          : "Couldn't check that link with Vimeo",
      });
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => { onChange(e.target.value); setState({ t: "idle" }); }}
          onBlur={(e) => void resolve(e.target.value)}
          placeholder="Paste the Vimeo link"
          className={INPUT}
        />
        <button
          type="button"
          onClick={() => { lastResolved.current = ""; void resolve(value); }}
          disabled={!value.trim() || state.t === "loading"}
          className="shrink-0 rounded-lg border border-black/15 px-3 py-2 text-xs font-medium transition hover:bg-black/5 disabled:opacity-40"
        >
          {state.t === "loading" ? "Checking…" : "Check"}
        </button>
      </div>

      {state.t === "ok" ? (
        <div className="mt-1.5 space-y-1 text-xs">
          <p className="text-emerald-700">
            ✓ {state.l.title ?? "Found on Vimeo"}
            {state.l.durationSeconds ? ` · ${hms(state.l.durationSeconds)}` : ""}
            {state.l.hash ? " · private hash added" : ""}
          </p>
          {state.l.domainRestricted ? (
            // The single commonest cause of a dead lesson, and invisible from
            // inside the iframe — so it is called out by name, with the domain.
            <p className="text-amber-700">
              Vimeo restricts this video to <strong>specific domains</strong>. It will
              still show &ldquo;because of its privacy settings&rdquo; until{" "}
              {host ? <code>{host}</code> : "this site's domain"} is added on Vimeo under
              Privacy → Where can this be embedded.
            </p>
          ) : !state.l.embeddable ? (
            <p className="text-rose-700">
              Vimeo has embedding switched off for this video entirely, so it won&rsquo;t
              play here. Set &ldquo;Where can this be embedded&rdquo; to Anywhere or to
              specific domains.
            </p>
          ) : null}
          {state.l.privacyView === "disable" && state.l.hash ? (
            <p className="text-ink/45">
              Private on Vimeo — the hash in the link is what grants access, so anyone
              reading the page source can watch it outside the portal.
            </p>
          ) : null}
        </div>
      ) : null}

      {state.t === "err" ? <p className="mt-1.5 text-xs text-rose-700">{state.msg}</p> : null}

      {state.t === "manual" ? (
        <p className="mt-1.5 text-xs text-ink/45">
          Automatic lookup is off (no Vimeo token on the server). If the video is
          &ldquo;Embed only&rdquo;, paste the <code>&lt;/&gt;</code> Embed snippet instead of
          Copy link — the share link omits the private hash it needs.
        </p>
      ) : null}

      {state.t === "idle" ? (
        <p className="mt-1.5 text-xs text-ink/45">
          Paste the share link — the private hash, title and length are filled in for you.
        </p>
      ) : null}
    </div>
  );
}

/** Shown under a video preview. Vimeo's "Because of its privacy settings…"
 *  screen has exactly two causes and neither is visible from inside the
 *  iframe, so the fix is spelled out rather than left to be guessed at. */
function EmbedHelp({ hasHash }: { hasHash: boolean }) {
  // Read after mount: the server has no window, and naming the actual host is
  // the whole point — "add your domain" is useless without saying which.
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => setHost(window.location.host), []);

  return (
    <details className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-ink/55">
      <summary className="cursor-pointer select-none">
        Preview shows &ldquo;Because of its privacy settings…&rdquo;?
      </summary>
      <div className="mt-2 space-y-2">
        <p>
          The video is fine — Vimeo is refusing to <em>embed</em> it on this site.
          On Vimeo open the video, then <strong>Settings → Privacy → &ldquo;Where can this
          be embedded?&rdquo;</strong> and choose <strong>Anywhere</strong>, or pick specific
          domains and add {host ? <code>{host}</code> : "this site's domain"}.
          Domain allowlisting needs a Vimeo Plus plan or higher.
        </p>
        <p>
          Also check <strong>&ldquo;Who can watch this video&rdquo;</strong> isn&rsquo;t set to
          Private or Only me — that blocks embedding whatever the embed setting says.
        </p>
        {!hasHash ? (
          <p>
            This link has no private hash, so it must be a public or domain-allowed
            video. If you make it unlisted, re-paste the full share link — the part
            after the ID is required to play it.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function KindIcon({ kind }: { kind: ResourceKind }) {
  const p = {
    width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (kind === "video" || kind === "recording")
    return <svg {...p} fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>;
  if (kind === "document")
    return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>;
  if (kind === "link")
    return <svg {...p}><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" /></svg>;
  return <svg {...p}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
}

// ─── shared field chrome ───────────────────────────────────────────────────

const INPUT =
  "w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400";

function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink/45">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-xs text-ink/45">{hint}</p> : null}
    </label>
  );
}

function PaneHeader({ eyebrow, title, children }: {
  eyebrow: string; title: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/5 pb-4">
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink/45">{eyebrow}</p>
        <h2 className="mt-1 font-serif text-2xl leading-tight">{title}</h2>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function ContentEditor({
  batch, content,
}: { batch: LmsAdminBatch; content: LmsAdminContent }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<Sel>(
    content.modules[0] ? { t: "module", id: content.modules[0].id } : { t: "batch" },
  );

  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    start(async () => {
      try { await fn(); router.refresh(); }
      catch (err) {
        setError(err instanceof ApiError
          ? String((err.body as { error?: string })?.error ?? err.message)
          : "Something went wrong");
      }
    });
  };

  const modules = content.modules;
  const resourcesOf = (id: string) => content.resources.filter((r) => r.moduleId === id);
  const courseworkOf = (id: string) => content.coursework.filter((c) => c.moduleId === id);

  /** Reassign sequential ranks after a move. Rewriting the whole list rather
   *  than swapping two values is deliberate: ranks arrive duplicated often
   *  enough (everything created with the same default) that a swap is a no-op
   *  exactly when you most need it to work. Only changed rows are PATCHed. */
  const move = <T extends { id: string; rank: number }>(
    items: T[], index: number, dir: -1 | 1,
    patch: (id: string, rank: number) => Promise<unknown>,
  ) => {
    const to = index + dir;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved!);
    run(() => Promise.all(
      next.flatMap((it, i) => (it.rank === i + 1 ? [] : [patch(it.id, i + 1)])),
    ));
  };

  const q = query.trim().toLowerCase();
  const matches = (s: string) => !q || s.toLowerCase().includes(q);

  const selected = useMemo(() => {
    if (sel.t === "resource") return content.resources.find((r) => r.id === sel.id) ?? null;
    if (sel.t === "coursework") return content.coursework.find((c) => c.id === sel.id) ?? null;
    if (sel.t === "module") return modules.find((m) => m.id === sel.id) ?? null;
    return null;
  }, [sel, content, modules]);

  // The selected row can vanish under us — deleted, or filtered out by a
  // rename. Fall back to the batch pane rather than rendering an empty box.
  const view: Sel = (sel.t === "resource" || sel.t === "coursework" || sel.t === "module") && !selected
    ? { t: "batch" }
    : sel;

  const totalPublished = modules.filter((m) => m.status === "published").length;

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[21rem_1fr]">
        {/* ── sidebar: the batch as a learner would see it ────────────────── */}
        <aside className="order-2 lg:order-1 lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-2xl border border-black/5 bg-white">
            <div className="space-y-3 border-b border-black/5 p-4">
              <button
                type="button"
                onClick={() => setSel({ t: "batch" })}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition",
                  view.t === "batch" ? "bg-indigo-50 font-medium text-indigo-900" : "hover:bg-black/[0.04]",
                )}
              >
                Batch settings
                <span className="font-mono text-[10px] uppercase text-ink/40">
                  {batchStatusLabel(batch.status)}
                </span>
              </button>

              <div className="relative">
                <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink/35"
                     width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this batch"
                  className="w-full rounded-lg border border-black/10 py-2 pl-9 pr-3 text-sm outline-none focus:border-indigo-400"
                />
              </div>

              <p className="font-mono text-[10px] uppercase tracking-wide text-ink/45">
                {modules.length} modules · {totalPublished} published · {content.resources.length} lessons
              </p>
            </div>

            <div className="max-h-[38rem] overflow-y-auto p-2">
              {modules.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-ink/45">
                  No modules yet. Add the first one below.
                </p>
              ) : null}

              {modules.map((m, mi) => {
                const res = resourcesOf(m.id);
                const cw = courseworkOf(m.id);
                const hitsModule = matches(m.title);
                const hitRes = res.filter((r) => hitsModule || matches(r.title));
                const hitCw = cw.filter((c) => hitsModule || matches(c.title));
                if (q && !hitsModule && hitRes.length === 0 && hitCw.length === 0) return null;

                const draft = m.status !== "published";

                return (
                  <div key={m.id} className="mb-3">
                    <div className="flex items-start gap-1 px-1 pb-1 pt-2">
                      <button
                        type="button"
                        onClick={() => setSel({ t: "module", id: m.id })}
                        className={cn(
                          "min-w-0 flex-1 rounded px-2 py-1 text-left transition hover:bg-black/[0.04]",
                          view.t === "module" && view.id === m.id ? "bg-indigo-50" : "",
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className={cn(
                            "truncate font-mono text-[10px] uppercase tracking-[0.1em]",
                            draft ? "text-amber-700" : "text-ink/45",
                          )}>
                            Module {mi + 1} · {m.title}
                          </span>
                        </span>
                        <span className="mt-0.5 block font-mono text-[10px] text-ink/40">
                          {draft ? "draft — hidden" : "published"}
                          {res.length ? ` · ${res.length} lessons` : " · empty"}
                        </span>
                      </button>

                      {/* Reordering lives in the sidebar because order is a
                          property of the LIST, not of the thing selected. */}
                      <div className="flex shrink-0 flex-col">
                        <button
                          type="button" disabled={pending || mi === 0}
                          onClick={() => move(modules, mi, -1, (id, rank) => updateLmsModule(id, { rank }))}
                          title="Move module up"
                          className="px-1 text-[9px] leading-none text-ink/35 hover:text-ink disabled:opacity-20"
                        >▲</button>
                        <button
                          type="button" disabled={pending || mi === modules.length - 1}
                          onClick={() => move(modules, mi, 1, (id, rank) => updateLmsModule(id, { rank }))}
                          title="Move module down"
                          className="px-1 text-[9px] leading-none text-ink/35 hover:text-ink disabled:opacity-20"
                        >▼</button>
                      </div>
                    </div>

                    <ul>
                      {hitRes.map((r) => {
                        const ri = res.findIndex((x) => x.id === r.id);
                        const on = view.t === "resource" && view.id === r.id;
                        return (
                          <li key={r.id} className="group flex items-center">
                            <button
                              type="button"
                              onClick={() => setSel({ t: "resource", id: r.id })}
                              className={cn(
                                "flex min-w-0 flex-1 items-start gap-2 border-l-2 py-1.5 pl-2.5 pr-2 text-left text-sm transition",
                                on ? "border-indigo-500 bg-indigo-50/70 font-medium text-indigo-900"
                                   : "border-transparent hover:bg-black/[0.04]",
                                !r.enabled ? "opacity-45" : "",
                              )}
                            >
                              <span className="mt-0.5 shrink-0 text-ink/45"><KindIcon kind={r.kind} /></span>
                              <span className="min-w-0 flex-1">
                                <span className={cn("block truncate leading-snug", !r.enabled ? "line-through" : "")}>
                                  {r.title}
                                </span>
                                <span className="block font-mono text-[10px] text-ink/40">
                                  {r.durationSeconds ? hms(r.durationSeconds) : RESOURCE_LABEL[r.kind]}
                                  {!r.required ? " · optional" : ""}
                                  {!r.enabled ? " · hidden" : ""}
                                </span>
                              </span>
                            </button>
                            <div className="flex shrink-0 flex-col opacity-0 transition group-hover:opacity-100">
                              <button
                                type="button" disabled={pending || ri === 0}
                                onClick={() => move(res, ri, -1, (id, rank) => updateLmsResource(id, { rank }))}
                                title="Move up"
                                className="px-1 text-[9px] leading-none text-ink/35 hover:text-ink disabled:opacity-20"
                              >▲</button>
                              <button
                                type="button" disabled={pending || ri === res.length - 1}
                                onClick={() => move(res, ri, 1, (id, rank) => updateLmsResource(id, { rank }))}
                                title="Move down"
                                className="px-1 text-[9px] leading-none text-ink/35 hover:text-ink disabled:opacity-20"
                              >▼</button>
                            </div>
                          </li>
                        );
                      })}

                      {hitCw.map((c) => {
                        const on = view.t === "coursework" && view.id === c.id;
                        return (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => setSel({ t: "coursework", id: c.id })}
                              className={cn(
                                "flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-2 text-left text-sm transition",
                                on ? "border-indigo-500 bg-indigo-50/70 font-medium text-indigo-900"
                                   : "border-transparent hover:bg-black/[0.04]",
                                !c.enabled ? "opacity-45" : "",
                              )}
                            >
                              <span className={cn(
                                "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold",
                                COURSEWORK_CHIP[c.type],
                              )}>
                                {COURSEWORK_LABEL[c.type]}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{c.title}</span>
                              {c.awaitingGrading > 0 ? (
                                <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-900">
                                  {c.awaitingGrading}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>

                    <div className="mt-1 flex gap-1 px-2">
                      <button
                        type="button"
                        onClick={() => setSel({ t: "newResource", moduleId: m.id })}
                        className="rounded px-1.5 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                      >
                        + Lesson
                      </button>
                      <button
                        type="button"
                        onClick={() => setSel({ t: "newCoursework", moduleId: m.id })}
                        className="rounded px-1.5 py-1 text-[11px] text-indigo-700 hover:bg-indigo-50"
                      >
                        + Coursework
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-black/5 p-3">
              <AddModule
                pending={pending}
                onAdd={(title) => run(async () => {
                  const created = await createLmsModule(batch.id, { title });
                  setSel({ t: "module", id: created.id });
                })}
              />
            </div>
          </div>
        </aside>

        {/* ── right pane: one thing at a time ─────────────────────────────── */}
        <div className="order-1 min-w-0 lg:order-2">
          <div className="rounded-2xl border border-black/5 bg-white p-6">
            {view.t === "batch" ? (
              <BatchPane batch={batch} pending={pending} run={run} />
            ) : null}

            {view.t === "module" && selected ? (
              <ModulePane
                key={view.id}
                module={selected as LmsAdminModule}
                resourceCount={resourcesOf(view.id).length}
                courseworkCount={courseworkOf(view.id).length}
                pending={pending}
                run={run}
                onDeleted={() => setSel({ t: "batch" })}
                onAddLesson={() => setSel({ t: "newResource", moduleId: view.id })}
              />
            ) : null}

            {view.t === "resource" && selected ? (
              <ResourcePane
                key={view.id}
                resource={selected as LmsAdminResource}
                pending={pending}
                run={run}
                onDeleted={() => setSel({ t: "batch" })}
              />
            ) : null}

            {view.t === "coursework" && selected ? (
              <CourseworkPane
                key={view.id}
                item={selected as LmsAdminCoursework}
                pending={pending}
                run={run}
                onDeleted={() => setSel({ t: "batch" })}
              />
            ) : null}

            {view.t === "newResource" ? (
              <>
                <PaneHeader eyebrow="New lesson" title="Add a lesson" />
                <div className="pt-5">
                  <ResourceForm
                    pending={pending}
                    onCancel={() => setSel({ t: "module", id: view.moduleId })}
                    onSubmit={(body) => run(async () => {
                      const created = await createLmsResource(view.moduleId, body);
                      setSel({ t: "resource", id: created.id });
                    })}
                  />
                </div>
              </>
            ) : null}

            {view.t === "newCoursework" ? (
              <>
                <PaneHeader eyebrow="New coursework" title="Add coursework" />
                <div className="pt-5">
                  <CourseworkForm
                    pending={pending}
                    onCancel={() => setSel({ t: "module", id: view.moduleId })}
                    onSubmit={(body) => run(async () => {
                      const created = await createLmsCoursework(view.moduleId, body);
                      setSel({ t: "coursework", id: created.id });
                    })}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── panes ─────────────────────────────────────────────────────────────────

type Run = (fn: () => Promise<unknown>) => void;

function AddModule({ pending, onAdd }: { pending: boolean; onAdd: (title: string) => void }) {
  const [title, setTitle] = useState("");
  return (
    <div className="flex gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && title.trim()) { onAdd(title.trim()); setTitle(""); }
        }}
        placeholder="New module title…"
        className="min-w-0 flex-1 rounded-lg border border-black/10 px-3 py-1.5 text-sm outline-none focus:border-indigo-400"
      />
      <button
        type="button"
        disabled={pending || !title.trim()}
        onClick={() => { onAdd(title.trim()); setTitle(""); }}
        className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
      >
        Add
      </button>
    </div>
  );
}

function BatchPane({ batch, pending, run }: {
  batch: LmsAdminBatch; pending: boolean; run: Run;
}) {
  const [joinUrl, setJoinUrl] = useState(batch.joinUrl ?? "");
  const [saved, setSaved] = useState(false);
  const dirty = joinUrl.trim() !== (batch.joinUrl ?? "").trim();

  return (
    <>
      <PaneHeader eyebrow="Batch settings" title={batch.name} />
      <div className="space-y-5 pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status">
            <select
              defaultValue={batch.status}
              onChange={(e) => run(() => updateLmsBatch(batch.id, { status: e.target.value }))}
              className={INPUT}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{batchStatusLabel(s)}</option>)}
            </select>
          </Field>
          <dl className="rounded-xl bg-black/[0.03] p-4 text-sm">
            <div className="flex justify-between gap-4 py-1">
              <dt className="text-ink/50">Learners assigned</dt>
              <dd className="font-medium">{batch.learnerCount}</dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-black/5 py-1">
              <dt className="text-ink/50">Modules published</dt>
              <dd className="font-medium">{batch.publishedCount} of {batch.moduleCount}</dd>
            </div>
          </dl>
        </div>

        <Field
          label="Live class join link"
          hint="Learners see this as a Join button on the batch page, on Today, and on each class in Schedule."
        >
          <input
            value={joinUrl}
            onChange={(e) => { setJoinUrl(e.target.value); setSaved(false); }}
            placeholder="https://us06web.zoom.us/j/… or https://meet.google.com/…"
            className={INPUT}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending || !dirty}
            onClick={() => run(async () => {
              await updateLmsBatch(batch.id, { joinUrl: joinUrl.trim() || null });
              setSaved(true);
            })}
            className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
          >
            {pending ? "Saving…" : dirty ? "Save link" : "Saved"}
          </button>
          {saved && !dirty ? (
            <span className="text-xs text-emerald-700">Saved — learners can now join.</span>
          ) : null}
        </div>

        <p className="rounded-xl bg-black/[0.03] px-4 py-3 text-xs text-ink/55">
          Dates, trainer and seats belong to the batch itself — change those in the CRM
          under Batches. This screen owns its content and its join link.
        </p>
      </div>
    </>
  );
}

function ModulePane({
  module: m, resourceCount, courseworkCount, pending, run, onDeleted, onAddLesson,
}: {
  module: LmsAdminModule; resourceCount: number; courseworkCount: number;
  pending: boolean; run: Run; onDeleted: () => void; onAddLesson: () => void;
}) {
  const [title, setTitle] = useState(m.title);
  const [summary, setSummary] = useState(m.summary ?? "");
  const dirty = title.trim() !== m.title || summary.trim() !== (m.summary ?? "");
  const published = m.status === "published";

  return (
    <>
      <PaneHeader eyebrow={`Module · rank ${m.rank}`} title={m.title}>
        <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium",
          published ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900")}>
          {published ? "Published" : "Draft"}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => updateLmsModule(m.id, { status: published ? "draft" : "published" }))}
          className="rounded-full border border-black/15 px-4 py-1.5 text-xs font-medium transition hover:bg-black/5 disabled:opacity-40"
        >
          {published ? "Unpublish" : "Publish"}
        </button>
      </PaneHeader>

      <div className="space-y-5 pt-5">
        {published && resourceCount === 0 ? (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Published, but there is nothing in it — learners open this batch and see an
            empty module. Add a lesson, or unpublish until it&rsquo;s ready.
          </p>
        ) : null}

        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
        </Field>

        <Field label="Summary" hint="Optional. Shown under the module heading.">
          <textarea
            value={summary} onChange={(e) => setSummary(e.target.value)} rows={3}
            className={cn(INPUT, "resize-y")}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending || !dirty || !title.trim()}
            onClick={() => run(() => updateLmsModule(m.id, {
              title: title.trim(), summary: summary.trim() || null,
            }))}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
          >
            {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          <button
            type="button"
            onClick={onAddLesson}
            className="rounded-full border border-black/15 px-5 py-2 text-sm font-medium transition hover:bg-black/5"
          >
            + Lesson
          </button>
          <span className="text-sm text-ink/45">
            {resourceCount} lessons · {courseworkCount} coursework
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete "${m.title}" and everything in it?`)) return;
              run(async () => { await deleteLmsModule(m.id); onDeleted(); });
            }}
            className="ml-auto rounded-full px-4 py-2 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-40"
          >
            Delete module
          </button>
        </div>
      </div>
    </>
  );
}

function ResourcePane({ resource: r, pending, run, onDeleted }: {
  resource: LmsAdminResource; pending: boolean; run: Run; onDeleted: () => void;
}) {
  const [title, setTitle] = useState(r.title);
  const [ref, setRef] = useState(r.videoRef ?? "");
  const [minutes, setMinutes] = useState(minutesOf(r.durationSeconds));
  const [body, setBody] = useState(r.body ?? "");
  const [url, setUrl] = useState(r.externalUrl ?? "");
  const [required, setRequired] = useState(r.required);
  const [enabled, setEnabled] = useState(r.enabled);

  const timed = r.kind === "video" || r.kind === "recording";
  // Compared in the unit actually persisted, so what you see is what's stored.
  const nextSeconds = secondsFrom(minutes);
  // Blanking the kind's payload column violates a CHECK. Block the save and
  // say so, rather than letting the database refuse it as a 500.
  const payload = payloadFor(r.kind);
  const payloadOk =
    timed ? !!vimeoRef(ref)
    : r.kind === "note" ? !!body.trim()
    : r.kind === "link" ? !!url.trim()
    : true;
  const dirty =
    title.trim() !== r.title ||
    (timed && vimeoRef(ref) !== (r.videoRef ?? "")) ||
    nextSeconds !== (r.durationSeconds ?? null) ||
    (r.kind === "note" && body !== (r.body ?? "")) ||
    (r.kind === "link" && url.trim() !== (r.externalUrl ?? "")) ||
    required !== r.required ||
    enabled !== r.enabled;

  const save = () => run(() => updateLmsResource(r.id, {
    title: title.trim(),
    ...(timed ? { videoRef: vimeoRef(ref) || null } : {}),
    durationSeconds: nextSeconds,
    ...(r.kind === "note" ? { body: body || null } : {}),
    ...(r.kind === "link" ? { externalUrl: url.trim() || null } : {}),
    required,
    enabled,
  }));

  return (
    <>
      <PaneHeader eyebrow={`${RESOURCE_LABEL[r.kind]} · rank ${r.rank}`} title={r.title}>
        {!r.enabled ? (
          <span className="rounded-full bg-black/10 px-2.5 py-0.5 text-[11px] font-medium text-ink/60">
            Hidden
          </span>
        ) : null}
        {!r.required ? (
          <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-[11px] font-medium text-ink/55">
            Optional
          </span>
        ) : null}
      </PaneHeader>

      <div className="space-y-5 pt-5">
        {/* Preview first — this is exactly what the learner gets. A wrong
            Vimeo id shows up here as a dead embed instead of in a support
            ticket three weeks later. */}
        {timed && r.videoRef ? (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-xl bg-black">
              <div className="relative aspect-video">
                <iframe
                  key={r.videoRef}
                  src={vimeoEmbedUrl(r.videoRef)}
                  title={r.title}
                  className="absolute inset-0 h-full w-full"
                  allow="fullscreen; picture-in-picture"
                  allowFullScreen
                />
              </div>
            </div>
            {/* The embed fails inside a cross-origin iframe, so we cannot read
                whether it errored — but the two causes are always the same two,
                and both are fixed elsewhere than in this app. Saying so here
                turns Vimeo's black "Sorry" box into something actionable. */}
            <EmbedHelp hasHash={!!splitVimeoRef(r.videoRef).hash} />
          </div>
        ) : r.kind === "note" && r.body ? (
          <article className="max-h-64 overflow-y-auto rounded-xl bg-black/[0.03] p-4">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Preview</p>
            <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink/80">{r.body}</div>
          </article>
        ) : r.kind === "link" && r.externalUrl ? (
          <div className="rounded-xl bg-black/[0.03] p-4">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink/45">Links to</p>
            <a href={r.externalUrl} target="_blank" rel="noreferrer"
               className="mt-1 block break-all text-sm text-indigo-700 hover:underline">
              {r.externalUrl}
            </a>
          </div>
        ) : null}

        <Field
          label="Kind"
          hint="A lesson's kind is fixed once created — the fields it stores differ. To change it, add a new lesson and delete this one."
        >
          <span className="inline-flex items-center gap-2 rounded-lg bg-black/[0.04] px-3 py-2 text-sm text-ink/70">
            <KindIcon kind={r.kind} />
            {RESOURCE_LABEL[r.kind]}
          </span>
        </Field>

        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
        </Field>

        {timed ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
            <Field label="Vimeo link or ID">
              <VimeoField
                value={ref}
                onChange={setRef}
                onResolved={(l) => {
                  // Only fill blanks — never overwrite a title an admin wrote
                  // by hand just because Vimeo happens to know a different one.
                  if (!title.trim() && l.title) setTitle(l.title);
                  if (!minutes.trim() && l.durationSeconds) setMinutes(minutesOf(l.durationSeconds));
                }}
              />
            </Field>
            <Field label="Length (min)">
              <input
                value={minutes} onChange={(e) => setMinutes(e.target.value)}
                inputMode="numeric" className={INPUT}
              />
            </Field>
          </div>
        ) : null}

        {r.kind === "note" ? (
          <Field label="Notes">
            <textarea
              value={body} onChange={(e) => setBody(e.target.value)} rows={10}
              className={cn(INPUT, "resize-y font-mono text-[13px]")}
            />
          </Field>
        ) : null}

        {r.kind === "link" ? (
          <Field label="URL">
            <input value={url} onChange={(e) => setUrl(e.target.value)} className={INPUT} />
          </Field>
        ) : null}

        {r.kind === "document" ? (
          <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-900">
            Document storage isn&rsquo;t configured, so learners can&rsquo;t open this. Set{" "}
            <code>BLOB_READ_WRITE_TOKEN</code> and <code>BLOB_STORE_ID</code> on the API,
            or replace this with a Link resource pointing at the file.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
            Counts toward completion
          </label>
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Visible to learners
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-4">
          <button
            type="button"
            disabled={pending || !dirty || !title.trim() || !payloadOk}
            onClick={save}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
          >
            {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          {!payloadOk && payload.required ? (
            <span className="text-xs text-rose-700">
              A {RESOURCE_LABEL[r.kind].toLowerCase()} must keep {payload.label}.
            </span>
          ) : dirty ? (
            <span className="text-xs text-amber-700">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete "${r.title}"? Learner progress on it goes too.`)) return;
              run(async () => { await deleteLmsResource(r.id); onDeleted(); });
            }}
            className="ml-auto rounded-full px-4 py-2 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-40"
          >
            Delete lesson
          </button>
        </div>
      </div>
    </>
  );
}

function CourseworkPane({ item: c, pending, run, onDeleted }: {
  item: LmsAdminCoursework; pending: boolean; run: Run; onDeleted: () => void;
}) {
  const [title, setTitle] = useState(c.title);
  const [brief, setBrief] = useState(c.brief ?? "");
  const [maxScore, setMaxScore] = useState(c.maxScore ?? "");
  const [passScore, setPassScore] = useState(c.passScore ?? "");
  const [opensAt, setOpensAt] = useState(toLocalInput(c.opensAt));
  const [dueAt, setDueAt] = useState(toLocalInput(c.dueAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(c.closesAt));
  const [enabled, setEnabled] = useState(c.enabled);

  // max_score / pass_score are numeric(6,2) — 10000 overflows the column and
  // comes back as an unexplained 500, so it is caught here instead.
  const scoreOk = (v: string) => {
    if (!v.trim()) return true;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n < 10_000;
  };
  const scoresOk = scoreOk(maxScore) && scoreOk(passScore);

  const dirty =
    title.trim() !== c.title ||
    brief.trim() !== (c.brief ?? "") ||
    !sameNumber(maxScore, c.maxScore) ||
    !sameNumber(passScore, c.passScore) ||
    opensAt !== toLocalInput(c.opensAt) ||
    dueAt !== toLocalInput(c.dueAt) ||
    closesAt !== toLocalInput(c.closesAt) ||
    enabled !== c.enabled;

  return (
    <>
      <PaneHeader eyebrow={`${COURSEWORK_LABEL[c.type]} · rank ${c.rank}`} title={c.title}>
        <a
          href={`/learn/admin/grade/${c.id}`}
          className={cn(
            "rounded-full px-4 py-1.5 text-xs font-medium transition",
            c.awaitingGrading > 0
              ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
              : "border border-black/15 hover:bg-black/5",
          )}
        >
          {c.awaitingGrading > 0 ? `${c.awaitingGrading} to grade` : "Submissions"}
        </a>
      </PaneHeader>

      <div className="space-y-5 pt-5">
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
        </Field>

        <Field label="Brief" hint="What the learner has to do. Shown on My work.">
          <textarea
            value={brief} onChange={(e) => setBrief(e.target.value)} rows={5}
            className={cn(INPUT, "resize-y")}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max score">
            <input value={maxScore} onChange={(e) => setMaxScore(e.target.value)} inputMode="numeric" className={INPUT} />
          </Field>
          <Field label="Pass score" hint="Optional.">
            <input value={passScore} onChange={(e) => setPassScore(e.target.value)} inputMode="numeric" className={INPUT} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Opens">
            <input type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} className={INPUT} />
          </Field>
          <Field label="Due">
            <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={INPUT} />
          </Field>
          <Field label="Closes">
            <input type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} className={INPUT} />
          </Field>
        </div>
        <p className="text-xs text-ink/45">
          Past <span className="font-medium">Due</span> a submission is marked late but still
          accepted; past <span className="font-medium">Closes</span> it is refused outright.
          Grading is by a trainer — auto-grading is reserved but not built.
        </p>

        <label className="flex items-center gap-2 text-sm text-ink/70">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Visible to learners
        </label>

        <div className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-4">
          <button
            type="button"
            disabled={pending || !dirty || !title.trim() || !scoresOk}
            onClick={() => run(() => updateLmsCoursework(c.id, {
              title: title.trim(),
              brief: brief.trim() || null,
              maxScore: maxScore.trim() ? Number(maxScore) : null,
              passScore: passScore.trim() ? Number(passScore) : null,
              opensAt: fromLocalInput(opensAt),
              dueAt: fromLocalInput(dueAt),
              closesAt: fromLocalInput(closesAt),
              enabled,
            }))}
            className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white transition hover:bg-ink/90 disabled:opacity-40"
          >
            {pending ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
          {!scoresOk ? (
            <span className="text-xs text-rose-700">Scores must be between 0 and 9999.99.</span>
          ) : dirty ? (
            <span className="text-xs text-amber-700">Unsaved changes</span>
          ) : null}
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete "${c.title}"?`)) return;
              run(async () => { await deleteLmsCoursework(c.id); onDeleted(); });
            }}
            className="ml-auto rounded-full px-4 py-2 text-sm text-rose-700 transition hover:bg-rose-50 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
    </>
  );
}

// ─── create forms ──────────────────────────────────────────────────────────

function ResourceForm({
  pending, onCancel, onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    title: string; kind: ResourceKind; videoRef?: string | null;
    durationSeconds?: number | null; body?: string | null;
    externalUrl?: string | null; required?: boolean;
  }) => void;
}) {
  const [kind, setKind] = useState<ResourceKind>("video");
  const [title, setTitle] = useState("");
  const [ref, setRef] = useState("");
  const [minutes, setMinutes] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [required, setRequired] = useState(true);

  const canSave = title.trim() && (
    kind === "video" || kind === "recording" ? ref.trim()
    : kind === "note" ? text.trim()
    : kind === "link" ? url.trim()
    : false   // document needs a Blob store — see the note below
  );

  return (
    <div className="space-y-4">
      <Field label="Kind" hint="Fixed once created — pick carefully.">
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k} type="button" onClick={() => setKind(k)}
              className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition",
                kind === k ? "bg-ink text-white" : "border border-black/10 hover:bg-black/5")}
            >
              <KindIcon kind={k} />
              {RESOURCE_LABEL[k]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Title">
        <input
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Optimisers: SGD to AdamW" className={INPUT}
        />
      </Field>

      {kind === "video" || kind === "recording" ? (
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <Field label="Vimeo link or ID">
            <VimeoField
              value={ref}
              onChange={setRef}
              onResolved={(l) => {
                if (!title.trim() && l.title) setTitle(l.title);
                if (!minutes.trim() && l.durationSeconds) setMinutes(minutesOf(l.durationSeconds));
              }}
            />
          </Field>
          <Field label="Length (min)">
            <input value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" className={INPUT} />
          </Field>
        </div>
      ) : null}

      {kind === "note" ? (
        <Field label="Notes">
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={8}
            placeholder="Markdown notes…" className={cn(INPUT, "resize-y font-mono text-[13px]")}
          />
        </Field>
      ) : null}

      {kind === "link" ? (
        <Field label="URL">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className={INPUT} />
        </Field>
      ) : null}

      {kind === "document" ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-900">
          Document upload needs a Vercel Blob store. Set <code>BLOB_READ_WRITE_TOKEN</code> and{" "}
          <code>BLOB_STORE_ID</code> on the API, then documents can be attached from the media library.
          Until then, use a Link resource pointing at the file.
        </p>
      ) : null}

      <label className="flex items-center gap-2 text-sm text-ink/70">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        Counts toward completion
      </label>

      <div className="flex gap-2 border-t border-black/5 pt-4">
        <button
          type="button"
          disabled={pending || !canSave}
          onClick={() => onSubmit({
            title: title.trim(),
            kind,
            videoRef: kind === "video" || kind === "recording" ? vimeoRef(ref) : null,
            durationSeconds: secondsFrom(minutes),
            body: kind === "note" ? text : null,
            externalUrl: kind === "link" ? url.trim() : null,
            required,
          })}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Add lesson
        </button>
        <button type="button" onClick={onCancel} className="rounded-full border border-black/10 px-5 py-2 text-sm hover:bg-black/5">
          Cancel
        </button>
      </div>
    </div>
  );
}

function CourseworkForm({
  pending, onCancel, onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: {
    title: string; type: CourseworkType; brief?: string | null;
    maxScore?: number | null; dueAt?: string | null;
  }) => void;
}) {
  const [type, setType] = useState<CourseworkType>("lab");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [maxScore, setMaxScore] = useState("100");
  const [dueAt, setDueAt] = useState("");

  return (
    <div className="space-y-4">
      <Field label="Type">
        <div className="flex flex-wrap gap-2">
          {TYPES.map((t) => (
            <button
              key={t} type="button" onClick={() => setType(t)}
              className={cn("rounded-full px-3 py-1.5 text-xs capitalize transition",
                type === t ? "bg-ink text-white" : "border border-black/10 hover:bg-black/5")}
            >
              {t}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Title">
        <input
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Lab: train on CIFAR-10" className={INPUT}
        />
      </Field>

      <Field label="Brief" hint="What the learner has to do.">
        <textarea
          value={brief} onChange={(e) => setBrief(e.target.value)} rows={4}
          className={cn(INPUT, "resize-y")}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Max score">
          <input value={maxScore} onChange={(e) => setMaxScore(e.target.value)} inputMode="numeric" className={INPUT} />
        </Field>
        <Field label="Due">
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className={INPUT} />
        </Field>
      </div>

      <p className="text-xs text-ink/45">
        Grading is by a trainer. Auto-grading is reserved but not built — a score entered here is final.
      </p>

      <div className="flex gap-2 border-t border-black/5 pt-4">
        <button
          type="button"
          disabled={pending || !title.trim()}
          onClick={() => onSubmit({
            title: title.trim(), type,
            brief: brief.trim() || null,
            maxScore: maxScore.trim() ? Number(maxScore) : null,
            dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          })}
          className="rounded-full bg-ink px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Add coursework
        </button>
        <button type="button" onClick={onCancel} className="rounded-full border border-black/10 px-5 py-2 text-sm hover:bg-black/5">
          Cancel
        </button>
      </div>
    </div>
  );
}
