// Authorization smoke test for the API's mount table.
//
// The migration doc proposed this as a Phase 1 requirement — "a test that
// enumerates every route file and asserts an unauthenticated call returns 401"
// — because hand-porting handlers into per-path files makes a forgotten guard
// invisible. Keeping the mount table intact is what makes that failure mode
// impossible, and this is the check that proves it rather than asserting it.
//
// Runs against the REAL app (src/server/app.ts), not a fixture. Never touches
// Postgres: requireAuth rejects a request with no bearer token before any
// handler, and the pool is lazily created, so nothing connects.
//
//   npx tsx scripts/verify-route-guards.ts

import { app } from "../src/server/app";
import { ApiResponse, buildRequest, type Handler } from "../src/server/http";

const BASE = "http://localhost:3000";

async function call(method: string, path: string, headers: Record<string, string> = {}) {
  const req = await buildRequest(new Request(`${BASE}${path}`, { method, headers }));
  const res = new ApiResponse();
  const out = await app.handle(req, res);
  let body: unknown = null;
  try { body = await out.clone().json(); } catch { /* non-JSON */ }
  return { status: out.status, body };
}

interface Case { method: string; path: string; expect: number | number[]; why: string }

// Every authenticated mount from src/server/app.ts. If a mount is ever moved
// above `app.use(authMiddleware)`, its entry here flips from 401 and the run
// fails — which is the whole point.
const PROTECTED = [
  "/me", "/leads", "/learners", "/enrollments", "/lms", "/lms-admin",
  "/approvals", "/cases", "/pipeline", "/activity", "/agents", "/records",
  "/summary", "/catalog", "/programs", "/cohorts", "/courses", "/workers",
  "/accounts", "/contacts", "/opportunities", "/requisitions", "/candidates",
  "/applications", "/users", "/advisors", "/groups", "/leaves", "/events",
  "/tasks", "/message-templates", "/batches", "/views", "/integrations",
  "/share-slack", "/share", "/parties", "/party", "/twilio", "/exotel",
  "/gmail", "/templates", "/campaigns", "/media",
];

const cases: Case[] = [
  // ── The auth fence ────────────────────────────────────────────────────
  ...PROTECTED.map((p): Case => ({
    method: "GET", path: p, expect: 401,
    why: `${p} is behind requireAuth`,
  })),
  // Sub-paths must be gated too, not just the mount root.
  { method: "GET",  path: "/leads/00000000-0000-0000-0000-000000000000", expect: 401, why: "nested lead path gated" },
  { method: "POST", path: "/leads", expect: 401, why: "writes gated" },
  { method: "DELETE", path: "/leads/abc", expect: 401, why: "deletes gated" },
  { method: "PATCH", path: "/applications/abc", expect: 401, why: "staffing decide-gate still behind auth" },

  // ── Deliberately public ───────────────────────────────────────────────
  // Intake answers 200 {ok:true} on a bad/missing key ON PURPOSE, so an
  // attacker can't distinguish "wrong key" from "rate limited".
  { method: "POST", path: "/leads/intake", expect: 200, why: "public intake (opaque 200 by design)" },
  { method: "POST", path: "/webhooks/twilio", expect: [403, 503], why: "public webhook, rejected on signature/config not auth" },
  // The exotel router registers /status and /inbound only — never a root
  // path. Its root 404s... except authMiddleware's "/" prefix catches the
  // fall-through first, so it reads as 401. Same as it did under Express.
  { method: "POST", path: "/webhooks/exotel/status",  expect: [200, 403, 503], why: "public webhook, IP-allowlisted not auth-gated" },
  { method: "GET",  path: "/webhooks/exotel/inbound", expect: [200, 403, 503], why: "Exotel Passthru arrives as GET with query params" },

  // ── Routing correctness ───────────────────────────────────────────────
  // Unmatched paths return 401, not 404, because `app.use(authMiddleware)` is
  // mounted at "/" and therefore runs for every request that gets that far.
  // That is Express's behaviour too, so it is preserved deliberately —
  // asserting 404 here would be asserting a regression.
  { method: "GET", path: "/definitely-not-a-route", expect: 401, why: "unknown path falls through to the auth fence, as under Express" },
  { method: "GET", path: "/leadsxyz", expect: 401, why: "not routed to leadsRouter; caught by the auth fence (see prefix unit check below)" },
  { method: "OPTIONS", path: "/leads", expect: 204, why: "CORS preflight short-circuits before auth" },
  { method: "GET", path: "/LEADS", expect: 401, why: "matching is case-insensitive, as Express was" },
  { method: "GET", path: "/leads/", expect: 401, why: "trailing slash tolerated, as Express was" },
];

// ── Dispatcher semantics ──────────────────────────────────────────────────
//
// Checked against a throwaway mount table rather than the real app, because
// the real app's auth fence at "/" answers 401 before a request can reveal
// whether it was routed correctly. These are the Express behaviours the whole
// migration leans on; if one breaks, requests silently go to the wrong handler.
async function dispatcherChecks(): Promise<Array<{ name: string; pass: boolean; detail: string }>> {
  const { createApp, Router } = await import("../src/server/http");
  const out: Array<{ name: string; pass: boolean; detail: string }> = [];
  const check = (name: string, pass: boolean, detail = "") => out.push({ name, pass, detail });

  const hit: string[] = [];
  const mark = (tag: string): Handler => (_req, res) => {
    hit.push(tag);
    return res.json({ tag });
  };

  const leads = Router();
  leads.get("/", mark("leads:list"));
  leads.get("/:id", mark("leads:byId"));
  leads.delete("/:id", mark("leads:delete"));

  // Second router on the SAME prefix — /leads/:id/convert lives here, which
  // only works if a non-matching first router falls through.
  const convert = Router();
  convert.post("/:idOrNumber/convert", mark("convert"));

  // A route-level guard chain, the shape used by 80+ registrations.
  const guarded = Router();
  guarded.get("/thing", (_req, res) => res.status(403).json({ error: "denied" }), mark("guarded:handler"));

  const testApp = createApp();
  testApp.use("/leads", leads);
  testApp.use("/leads", convert);
  testApp.use("/g", guarded);

  const fire = async (method: string, path: string) => {
    const req = await buildRequest(new Request(`${BASE}${path}`, { method }));
    const res = new ApiResponse();
    const r = await testApp.handle(req, res);
    let body: Record<string, unknown> = {};
    try { body = await r.clone().json(); } catch { /* ignore */ }
    return { status: r.status, body };
  };

  let r = await fire("GET", "/leads");
  check("mount root routes to the router's '/'", r.body.tag === "leads:list", `got ${JSON.stringify(r.body)}`);

  r = await fire("GET", "/leads/42");
  check("path param extracted", r.body.tag === "leads:byId", `got ${JSON.stringify(r.body)}`);

  r = await fire("DELETE", "/leads/42");
  check("verb routing distinguishes DELETE from GET", r.body.tag === "leads:delete", `got ${JSON.stringify(r.body)}`);

  r = await fire("POST", "/leads/LEAD-1/convert");
  check("falls through to the 2nd router on the same prefix", r.body.tag === "convert", `got ${JSON.stringify(r.body)}`);

  r = await fire("GET", "/leadsxyz");
  check("prefix matches on a segment boundary, not a substring", r.status === 404, `got ${r.status}, expected 404`);

  r = await fire("GET", "/leads/42/nope");
  check("unmatched sub-path 404s", r.status === 404, `got ${r.status}`);

  r = await fire("GET", "/g/thing");
  check("route-level guard short-circuits its handler", r.status === 403 && !hit.includes("guarded:handler"), `got ${r.status}, hit=${hit.join(",")}`);

  // Params must be URL-decoded, since lead numbers and emails travel in paths.
  r = await fire("GET", "/leads/a%40b.com");
  check("path params are URL-decoded", r.body.tag === "leads:byId", `got ${JSON.stringify(r.body)}`);

  return out;
}

async function main() {
  const results = await Promise.all(
    cases.map(async (c) => {
      try {
        const { status } = await call(c.method, c.path);
        const want = Array.isArray(c.expect) ? c.expect : [c.expect];
        return { ...c, got: status as number | string, pass: want.includes(status) };
      } catch (err) {
        return { ...c, got: `threw: ${(err as Error).message}`, pass: false };
      }
    }),
  );

  const failed = results.filter((r) => !r.pass);

  for (const r of failed) {
    console.error(
      `FAIL  ${r.method.padEnd(7)} ${r.path.padEnd(46)} want ${JSON.stringify(r.expect)}, got ${r.got}   (${r.why})`,
    );
  }

  console.log(`\nauth fence:  ${results.length - failed.length}/${results.length} passed`);

  const dispatch = await dispatcherChecks();
  const dispatchFailed = dispatch.filter((d) => !d.pass);
  for (const d of dispatchFailed) {
    console.error(`FAIL  dispatcher: ${d.name} — ${d.detail}`);
  }
  console.log(`dispatcher:  ${dispatch.length - dispatchFailed.length}/${dispatch.length} passed`);

  const total = failed.length + dispatchFailed.length;
  if (total > 0) {
    console.error(`\n${total} FAILED — routing or authorization does not match the mount table.`);
    process.exit(1);
  }
  console.log("\nEvery authenticated mount rejects an unauthenticated call, public routes stay public,");
  console.log("and the dispatcher reproduces Express's routing semantics.");
}

void main();
