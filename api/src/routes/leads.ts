import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const leadsRouter = Router();

// Human-readable label for an edit-diff field. Used by PATCH /leads to render
// activity rows like "Score: 65 → 78" rather than dumping camelCase keys.
function humanFieldLabel(field: string): string {
  const map: Record<string, string> = {
    name: "Name",
    email: "Email",
    phone: "Phone",
    city: "City",
    value: "Deal value",
    description: "Description",
    paymentProofUrl: "Payment proof",
    nbaLabel: "Next-best action",
    nbaIcon: "NBA icon",
    source: "Source",
    score: "Score",
    feePaid: "Fee paid",
    feeDue: "Fee due",
    dueDate: "Due date",
    registeredDate: "Registered date",
    heat: "Heat",
    stage: "Stage",
    program: "Program",
    advisor: "Advisor",
  };
  return map[field] ?? field;
}

// ─── helpers used only by POST /leads ─────────────────────────────────────

type Heat = "hot" | "warm" | "cold";
type Stage = "new" | "qual" | "demo" | "neg" | "won";

const HEAT_LABEL: Record<Heat, string> = { hot: "Hot lead", warm: "Warm lead", cold: "Cold lead" };
const HEAT_DESC: Record<Heat, string> = {
  hot:  "High intent, high fit. Move fast — agents flag this lead as a priority for outreach today.",
  warm: "Engaged but not yet decisive. Keep nurturing — share outcomes and case studies.",
  cold: "Low signal so far. Drip content automatically; revisit only if intent rises.",
};
const STAGE_LABEL: Record<Stage, string> = {
  new: "New inbound", qual: "Qualified", demo: "Demo / Trial",
  neg: "Negotiation", won: "Enrolled",
};
const AVATAR_GRADS = ["magenta", "violet", "blue", "ochre", "ok", "mute", "vm"] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function pickAvatar(name: string): string {
  // Deterministic: same name → same avatar gradient. Avoids re-render flicker.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_GRADS[h % AVATAR_GRADS.length]!;
}

function deriveHeat(score: number): Heat {
  return score >= 75 ? "hot" : score >= 45 ? "warm" : "cold";
}

function deriveSignals(score: number, stage: Stage, source: string) {
  const out: { text: string; weight: string; kind: "pos" | "neg" | "neu" }[] = [];
  if (score >= 85) {
    out.push({ text: "Visited pricing page in last 24h", weight: "+12", kind: "pos" });
    out.push({ text: "Replied to last touch within an hour", weight: "+9", kind: "pos" });
  } else if (score >= 60) {
    out.push({ text: "Watched intro lesson · 60%+", weight: "+8", kind: "pos" });
    out.push({ text: "Opened last 2 emails", weight: "+5", kind: "pos" });
  } else if (score >= 40) {
    out.push({ text: "Attended free webinar", weight: "+6", kind: "pos" });
    out.push({ text: "Slow email open rate", weight: "−4", kind: "neg" });
  } else {
    out.push({ text: "Limited site activity", weight: "−6", kind: "neg" });
    out.push({ text: "No reply in 7 days", weight: "−5", kind: "neg" });
  }
  if (stage === "demo")  out.push({ text: "Booked a live demo", weight: "+11", kind: "pos" });
  if (stage === "neg")   out.push({ text: "Asked about pricing / EMI", weight: "+10", kind: "pos" });
  if (stage === "won")   out.push({ text: "Enrolment payment confirmed", weight: "+15", kind: "pos" });
  if (stage === "new")   out.push({ text: "First-touch · cold start", weight: "neutral", kind: "neu" });
  if (source === "referral") out.push({ text: "Came in via referral · pre-qualified", weight: "+7", kind: "pos" });
  return out.slice(0, 4);
}

function deriveNba(name: string, heat: Heat, stage: Stage, score: number, nbaLabel: string, programName: string) {
  const firstName = name.split(" ")[0]!;
  const confidence = Math.min(95, Math.max(55, score - 5));
  if (stage === "won") {
    return { confidence, headline: `${firstName} is enrolled — ask for a referral within the next 7 days.`,
      why: `Recent enrollees in ${programName} convert into referrals at 31% when asked in the first onboarding week.` };
  }
  if (stage === "neg") {
    return { confidence, headline: `Send the next step: ${nbaLabel.toLowerCase()}.`,
      why: `${firstName} has signalled buying intent — agent has prepared the relevant offer.` };
  }
  if (stage === "demo") {
    return { confidence, headline: `${firstName} is in the demo flow — ${nbaLabel.toLowerCase()}.`,
      why: `Action keeps momentum going while ${firstName} is still warm.` };
  }
  if (heat === "warm") {
    return { confidence, headline: `${firstName} is warming up — share an alumni outcome from ${programName}.`,
      why: `Mid-funnel leads convert 1.8× better when shown a peer outcome before the discovery call.` };
  }
  if (heat === "cold") {
    return { confidence, headline: `Don't disturb yet — keep ${firstName} on the drip sequence.`,
      why: `Score is too low for direct outreach. The drip will deliver one weekly nudge until intent rises above 50.` };
  }
  return { confidence, headline: nbaLabel,
    why: `Agent flagged this as the highest-leverage move based on the current signals.` };
}

function deriveAssignments(stage: Stage, score: number) {
  type Row = { agentKey: string; status: string; badgeLabel: string; badgeKind: "run" | "done"; rank: number };
  const rows: Row[] = [];
  rows.push({
    agentKey: "scoring",
    status: `Initial score: ${score} · ${score >= 75 ? "hot" : score >= 45 ? "warm" : "cold"}`,
    badgeLabel: "done", badgeKind: "done", rank: 10,
  });
  if (stage === "demo" || stage === "qual") {
    rows.push({ agentKey: "outreach",  status: "Drafted next message · awaiting approval", badgeLabel: "queued",  badgeKind: "run",  rank: 0 });
    rows.push({ agentKey: "scheduler", status: "Watching calendar for the next demo slot",  badgeLabel: "standby", badgeKind: "run",  rank: 20 });
  } else if (stage === "neg") {
    rows.push({ agentKey: "outreach",  status: "Prepared offer · pending advisor sign-off", badgeLabel: "queued",  badgeKind: "run",  rank: 0 });
  } else if (stage === "won") {
    rows.push({ agentKey: "onboarding",status: "Tracking onboarding milestones",             badgeLabel: "running", badgeKind: "run",  rank: 0 });
  } else if (stage === "new") {
    rows.push({ agentKey: "outreach",  status: "Welcome + syllabus auto-sent",               badgeLabel: "done",    badgeKind: "done", rank: 0 });
  }
  return rows;
}

// ─── POST /leads — create a new lead ──────────────────────────────────────

leadsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const errors: string[] = [];
    const name = String(b.name ?? "").trim();
    if (!name) errors.push("name is required");
    const email   = b.email   ? String(b.email).trim()   : null;
    const phone   = b.phone   ? String(b.phone).trim()   : null;
    const city    = b.city    ? String(b.city).trim()    : null;
    const programName = b.program ? String(b.program).trim() : null;
    const programId   = b.programId ? String(b.programId).trim() : null;
    const value   = b.value   ? String(b.value).trim()   : null;
    const source  = b.source  ? String(b.source).trim()  : "web";
    const sourceLabel = b.sourceLabel ? String(b.sourceLabel).trim() : "Website form";
    const stage  = (b.stage ?? "new") as Stage;
    if (!["new","qual","demo","neg","won"].includes(stage)) errors.push("stage invalid");
    const score = b.score != null ? Number(b.score) : 50;
    if (Number.isNaN(score) || score < 0 || score > 100) errors.push("score must be 0..100");
    const heat: Heat = (b.heat as Heat) ?? deriveHeat(score);
    if (!["hot","warm","cold"].includes(heat)) errors.push("heat invalid");
    const nbaLabel = b.nbaLabel ? String(b.nbaLabel).trim() : "Reach out today";
    const nbaIcon  = b.nbaIcon  ? String(b.nbaIcon).trim()  : "send";
    const advisorId = b.advisorId ? String(b.advisorId).trim() : null;

    if (errors.length) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      // Resolve advisor: explicit id wins; otherwise pick first admin.
      let resolvedAdvisorId = advisorId;
      if (!resolvedAdvisorId) {
        const r = await db.execute(sql`
          SELECT id FROM app_user WHERE role = 'admin' AND active = true ORDER BY created_at LIMIT 1
        `);
        resolvedAdvisorId = (r.rows[0] as { id: string } | undefined)?.id ?? null;
      }

      // Next human number
      const numR = await db.execute(sql`SELECT nextval('seq_lead')::text AS n`);
      const number = `LEAD-${(numR.rows[0] as { n: string }).n}`;

      // 1. party
      const partyR = await db.execute(sql`
        INSERT INTO party (tenant_id, kind, name, email, phone, city, identifiers, attributes)
        VALUES (
          current_tenant(), 'person', ${name}, ${email}, ${phone}, ${city},
          ${JSON.stringify({ source })}::jsonb,
          ${JSON.stringify({ initials: initialsOf(name) })}::jsonb
        )
        RETURNING id
      `);
      const partyId = (partyR.rows[0] as { id: string }).id;

      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role)
        VALUES (current_tenant(), ${partyId}, 'lead')
      `);

      // 2. work_item
      const wiR = await db.execute(sql`
        INSERT INTO work_item (tenant_id, number, type, party_id, assignee_id, state)
        VALUES (
          current_tenant(), ${number}, 'lead', ${partyId},
          ${resolvedAdvisorId},
          ${stage === "won" ? "closed_won" : stage === "neg" ? "in_progress" : "open"}
        )
        RETURNING id, created_at
      `);
      const wiId = (wiR.rows[0] as { id: string }).id;
      const wiCreatedAt = new Date((wiR.rows[0] as { created_at: string }).created_at);

      // Resolve programId: prefer explicit FK, else look up by name.
      let resolvedProgramId = programId;
      if (!resolvedProgramId && programName) {
        const r = await db.execute(sql`SELECT id FROM program WHERE LOWER(name) = LOWER(${programName}) LIMIT 1`);
        resolvedProgramId = (r.rows[0] as { id: string } | undefined)?.id ?? null;
      }

      // 3. lead — every column populated
      const nba = deriveNba(name, heat, stage, score, nbaLabel, programName ?? "the program");
      await db.execute(sql`
        INSERT INTO lead (
          work_item_id, tenant_id,
          source, source_label, score, score_label, score_desc, heat,
          city, program, program_id, value, stage, stage_label,
          advisor_id, avatar, initials,
          nba_icon, nba_label, nba_ghost,
          nba_confidence, nba_headline, nba_why
        ) VALUES (
          ${wiId}, current_tenant(),
          ${source}, ${sourceLabel}, ${score}, ${HEAT_LABEL[heat]}, ${HEAT_DESC[heat]}, ${heat},
          ${city}, ${programName}, ${resolvedProgramId}, ${value}, ${stage}, ${STAGE_LABEL[stage]},
          ${resolvedAdvisorId}, ${pickAvatar(name)}, ${initialsOf(name)},
          ${nbaIcon}, ${nbaLabel}, false,
          ${nba.confidence}, ${nba.headline}, ${nba.why}
        )
      `);

      // 4. signals
      const signals = deriveSignals(score, stage, source);
      for (let i = 0; i < signals.length; i++) {
        const s = signals[i]!;
        await db.execute(sql`
          INSERT INTO lead_score_signal (tenant_id, work_item_id, text, weight, kind, rank)
          VALUES (current_tenant(), ${wiId}, ${s.text}, ${s.weight}, ${s.kind}, ${i})
        `);
      }

      // 5. agent assignments — resolve agent.key → agent.id
      const assignments = deriveAssignments(stage, score);
      for (const a of assignments) {
        const agR = await db.execute(sql`
          SELECT id FROM agent WHERE key = ${a.agentKey} LIMIT 1
        `);
        const aid = (agR.rows[0] as { id: string } | undefined)?.id;
        if (!aid) continue;
        await db.execute(sql`
          INSERT INTO agent_assignment (tenant_id, work_item_id, agent_id, status, badge_label, badge_kind, rank)
          VALUES (current_tenant(), ${wiId}, ${aid}, ${a.status}, ${a.badgeLabel}, ${a.badgeKind}, ${a.rank})
          ON CONFLICT DO NOTHING
        `);
      }

      // 6. seed timeline (3 rows)
      const firstName = name.split(" ")[0]!;
      const fmt = (d: Date) =>
        d.toLocaleDateString("en-IN", { month: "short", day: "numeric" }) + " · " +
        d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });

      const timelineRows = [
        { off: 0,
          actorType: "agent", actorName: "Lead Scoring Agent", verb: "AI · Score",
          detail: `Initial score: ${score}. Stage routed to "${stage}".`,
          tag: "ai" as const,
        },
        { off: 5,
          actorType: "agent", actorName: "Outreach Agent", verb: "AI · Draft",
          detail: stage === "won"
            ? `Confirmation email sent. ${firstName} is now in the onboarding flow.`
            : `Drafted the next-best touch for ${firstName}.`,
          tag: "ai" as const,
        },
        { off: 10,
          actorType: "user", actorName: firstName, verb: "Lead",
          detail: stage === "new"   ? "Submitted the inbound form."
                : stage === "demo"  ? "Booked a demo slot."
                : stage === "won"   ? "Completed payment."
                :                     "Engaged with the most recent agent message.",
          tag: "you" as const,
        },
      ];

      for (const r of timelineRows) {
        const ts = new Date(wiCreatedAt.getTime() + r.off * 60_000);
        await db.execute(sql`
          INSERT INTO activity (
            tenant_id, work_item_id, party_id,
            actor_type, actor_name, verb, detail, tag, payload, ts
          ) VALUES (
            current_tenant(), ${wiId}, ${partyId},
            ${r.actorType}, ${r.actorName}, ${r.verb}, ${r.detail}, ${r.tag},
            ${JSON.stringify({ when: fmt(ts), quote: null })}::jsonb,
            ${ts.toISOString()}
          )
        `);
      }

      return { id: wiId, number };
    });

    res.status(201).json({ lead: result });
  } catch (err) {
    next(err);
  }
});

// ─── GET /leads — list ────────────────────────────────────────────────────

leadsRouter.get("/", async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      // A person is a "lead" only while their lead party_role is current
      // (valid_to IS NULL). Once converted to learner, the lead role gets
      // end-dated and they disappear from this list.
      const r = await db.execute(sql`
        SELECT
          wi.id              AS id,
          wi.number          AS number,
          p.name             AS name,
          l.initials         AS initials,
          l.city             AS city,
          l.program          AS program,
          l.value            AS value,
          l.stage            AS stage,
          l.stage_label      AS "stageLabel",
          l.score            AS score,
          l.heat             AS heat,
          l.avatar           AS avatar,
          l.nba_icon         AS "nbaIcon",
          l.nba_label        AS "nbaLabel",
          l.nba_ghost        AS "nbaGhost",
          l.fee_paid         AS "feePaid",
          l.fee_due          AS "feeDue",
          l.due_date         AS "dueDate",
          l.registered_date  AS "registeredDate"
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        JOIN party p      ON p.id  = wi.party_id
        WHERE EXISTS (
          SELECT 1 FROM party_role pr
          WHERE pr.party_id = p.id AND pr.role = 'lead' AND pr.valid_to IS NULL
        )
        ORDER BY l.score DESC NULLS LAST
      `);
      return r.rows;
    });
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /leads/:idOrNumber — edit lead fields ──────────────────────────

leadsRouter.patch("/:idOrNumber", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const b = req.body ?? {};

    // Validate stage / heat if provided
    if (b.stage !== undefined && !["new","qual","demo","neg","won"].includes(String(b.stage))) {
      return res.status(400).json({ error: "stage invalid" });
    }
    if (b.heat !== undefined && !["hot","warm","cold"].includes(String(b.heat))) {
      return res.status(400).json({ error: "heat invalid" });
    }

    const updated = await withTenant(req.tenantId!, async (db) => {
      // Resolve work_item by id or number AND fetch current values so we can
      // compute a *real diff* — only fields that actually changed get logged.
      const beforeR = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id, wi.party_id AS "partyId",
                     p.name, p.email, p.phone, p.city,
                     l.value, l.source, l.source_label AS "sourceLabel", l.description,
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.payment_proof_url AS "paymentProofUrl",
                     l.score, l.heat, l.stage, l.stage_label AS "stageLabel",
                     l.nba_label AS "nbaLabel", l.nba_icon AS "nbaIcon",
                     l.advisor_id AS "advisorId",
                     l.program_id AS "programId", l.program AS "programName"
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              JOIN lead  l ON l.work_item_id = wi.id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'lead'
            `
          : sql`
              SELECT wi.id, wi.party_id AS "partyId",
                     p.name, p.email, p.phone, p.city,
                     l.value, l.source, l.source_label AS "sourceLabel", l.description,
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.payment_proof_url AS "paymentProofUrl",
                     l.score, l.heat, l.stage, l.stage_label AS "stageLabel",
                     l.nba_label AS "nbaLabel", l.nba_icon AS "nbaIcon",
                     l.advisor_id AS "advisorId",
                     l.program_id AS "programId", l.program AS "programName"
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              JOIN lead  l ON l.work_item_id = wi.id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'lead'
            `,
      );
      if (!beforeR.rows[0]) return null;
      const before = beforeR.rows[0] as Record<string, unknown>;
      const wiId    = before.id      as string;
      const partyId = before.partyId as string;

      // Build party update
      const norm = (v: unknown) => v == null || v === "" ? null : String(v).trim();
      if (b.name !== undefined) {
        await db.execute(sql`UPDATE party SET name = ${String(b.name).trim()} WHERE id = ${partyId}`);
      }
      if (b.email !== undefined) {
        await db.execute(sql`UPDATE party SET email = ${norm(b.email)} WHERE id = ${partyId}`);
      }
      if (b.phone !== undefined) {
        await db.execute(sql`UPDATE party SET phone = ${norm(b.phone)} WHERE id = ${partyId}`);
      }
      if (b.city !== undefined) {
        await db.execute(sql`UPDATE party SET city = ${norm(b.city)} WHERE id = ${partyId}`);
        // Also update lead.city (denormalized)
        await db.execute(sql`UPDATE lead SET city = ${norm(b.city)} WHERE work_item_id = ${wiId}`);
      }

      // Build lead update (dynamic SET)
      const leadSets: ReturnType<typeof sql>[] = [];
      if (b.value !== undefined)  leadSets.push(sql`value = ${b.value ? String(b.value).trim() : null}`);
      if (b.source !== undefined) leadSets.push(sql`source = ${b.source ? String(b.source).trim() : null}`);
      if (b.sourceLabel !== undefined) leadSets.push(sql`source_label = ${b.sourceLabel ? String(b.sourceLabel).trim() : null}`);
      if (b.score !== undefined) {
        const n = Number(b.score);
        if (Number.isNaN(n) || n < 0 || n > 100) return { kind: "bad-score" as const };
        leadSets.push(sql`score = ${n}`);
        // Auto-derive heat if not provided
        if (b.heat === undefined) {
          const h = n >= 75 ? "hot" : n >= 45 ? "warm" : "cold";
          leadSets.push(sql`heat = ${h}`);
        }
      }
      if (b.heat !== undefined) leadSets.push(sql`heat = ${String(b.heat)}`);
      if (b.stage !== undefined) {
        const STAGE_LABEL: Record<string, string> = {
          new: "New inbound", qual: "Qualified", demo: "Demo / Trial",
          neg: "Negotiation", won: "Enrolled",
        };
        leadSets.push(sql`stage = ${String(b.stage)}`);
        leadSets.push(sql`stage_label = ${STAGE_LABEL[String(b.stage)] ?? String(b.stage)}`);
      }
      if (b.nbaLabel !== undefined) leadSets.push(sql`nba_label = ${b.nbaLabel ? String(b.nbaLabel).trim() : null}`);
      if (b.nbaIcon  !== undefined) leadSets.push(sql`nba_icon  = ${b.nbaIcon  ? String(b.nbaIcon).trim()  : null}`);
      if (b.advisorId !== undefined) leadSets.push(sql`advisor_id = ${b.advisorId || null}`);
      // New: description + payment trail
      if (b.description !== undefined) leadSets.push(sql`description = ${b.description ? String(b.description) : null}`);
      if (b.feePaid !== undefined)
        leadSets.push(sql`fee_paid = ${b.feePaid !== null && b.feePaid !== "" ? String(b.feePaid) : null}`);
      if (b.feeDue !== undefined)
        leadSets.push(sql`fee_due  = ${b.feeDue  !== null && b.feeDue  !== "" ? String(b.feeDue)  : null}`);
      if (b.dueDate !== undefined)
        leadSets.push(sql`due_date = ${b.dueDate || null}`);
      if (b.registeredDate !== undefined)
        leadSets.push(sql`registered_date = ${b.registeredDate || null}`);
      if (b.paymentProofUrl !== undefined)
        leadSets.push(sql`payment_proof_url = ${b.paymentProofUrl ? String(b.paymentProofUrl).trim() : null}`);
      let newProgramName: string | null = null;
      if (b.programId !== undefined) {
        leadSets.push(sql`program_id = ${b.programId || null}`);
        if (b.programId) {
          const prog = await db.execute(sql`SELECT name FROM program WHERE id = ${b.programId}`);
          newProgramName = (prog.rows[0] as { name: string } | undefined)?.name ?? null;
          if (newProgramName) leadSets.push(sql`program = ${newProgramName}`);
        }
      }
      if (leadSets.length > 0) {
        const set = sql.join(leadSets, sql`, `);
        await db.execute(sql`UPDATE lead SET ${set} WHERE work_item_id = ${wiId}`);
      }

      // Resolve advisor name (for the diff line)
      let newAdvisorName: string | null | undefined = undefined;
      if (b.advisorId !== undefined) {
        if (b.advisorId) {
          const u = await db.execute(sql`SELECT name FROM app_user WHERE id = ${b.advisorId}`);
          newAdvisorName = (u.rows[0] as { name: string } | undefined)?.name ?? null;
        } else {
          newAdvisorName = null;
        }
      }

      // ── Diff: only log fields whose value actually changed ──────────────
      // The shape of "before" is straight from the DB; we compare against the
      // request body's `b` (and resolved-name columns).
      type Change = { field: string; from: unknown; to: unknown };
      const changes: Change[] = [];

      const eqStr = (a: unknown, c: unknown) =>
        (a == null || a === "" ? "" : String(a).trim()) ===
        (c == null || c === "" ? "" : String(c).trim());
      const eqNum = (a: unknown, c: unknown) =>
        (a == null || a === "" ? null : Number(a)) ===
        (c == null || c === "" ? null : Number(c));

      // Simple text/number fields
      const textFields: Array<[string, string]> = [
        ["name", "name"], ["email", "email"], ["phone", "phone"], ["city", "city"],
        ["value", "value"], ["description", "description"],
        ["paymentProofUrl", "paymentProofUrl"],
        ["nbaLabel", "nbaLabel"], ["nbaIcon", "nbaIcon"],
      ];
      for (const [in_, prev] of textFields) {
        if (b[in_] === undefined) continue;
        if (!eqStr(before[prev], b[in_])) {
          changes.push({ field: in_, from: before[prev], to: b[in_] });
        }
      }

      // Source: log only sourceLabel (human-readable) when it changed
      if (b.sourceLabel !== undefined && !eqStr(before.sourceLabel, b.sourceLabel)) {
        changes.push({ field: "source", from: before.sourceLabel, to: b.sourceLabel });
      }

      // Numeric / money
      const numFields: Array<[string, string]> = [
        ["score", "score"], ["feePaid", "feePaid"], ["feeDue", "feeDue"],
      ];
      for (const [in_, prev] of numFields) {
        if (b[in_] === undefined) continue;
        if (!eqNum(before[prev], b[in_])) {
          changes.push({ field: in_, from: before[prev], to: b[in_] });
        }
      }

      // Dates (compare as YYYY-MM-DD)
      const dayOf = (v: unknown) => v ? String(v).slice(0, 10) : "";
      for (const [in_, prev] of [["dueDate", "dueDate"], ["registeredDate", "registeredDate"]] as const) {
        if (b[in_] === undefined) continue;
        if (dayOf(before[prev]) !== dayOf(b[in_])) {
          changes.push({ field: in_, from: before[prev], to: b[in_] });
        }
      }

      // Enums
      if (b.heat !== undefined && before.heat !== b.heat) {
        changes.push({ field: "heat", from: before.heat, to: b.heat });
      }
      if (b.stage !== undefined && before.stage !== b.stage) {
        changes.push({ field: "stage", from: before.stage, to: b.stage });
      }

      // Program / advisor — resolve to names for readability
      if (b.programId !== undefined && before.programId !== b.programId) {
        changes.push({ field: "program", from: before.programName ?? "—", to: newProgramName ?? "—" });
      }
      if (b.advisorId !== undefined) {
        const beforeAdv = before.advisorId ?? null;
        const afterAdv  = b.advisorId || null;
        if (beforeAdv !== afterAdv) {
          // Look up old name too — once
          let oldName: string | null = null;
          if (beforeAdv) {
            const u = await db.execute(sql`SELECT name FROM app_user WHERE id = ${beforeAdv as string}`);
            oldName = (u.rows[0] as { name: string } | undefined)?.name ?? null;
          }
          changes.push({ field: "advisor", from: oldName ?? "unassigned", to: newAdvisorName ?? "unassigned" });
        }
      }

      // ── Render the diff into a human-friendly detail string ─────────────
      if (changes.length > 0) {
        const fmtVal = (v: unknown): string => {
          if (v == null || v === "") return "—";
          if (typeof v === "string" && v.length > 40) return `"${v.slice(0, 40)}…"`;
          if (typeof v === "string") return `"${v}"`;
          return String(v);
        };
        const moneyFields = new Set(["feePaid", "feeDue"]);
        const renderMoney = (v: unknown): string => v == null || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN")}`;

        const lines = changes.map((c) => {
          const label = humanFieldLabel(c.field);
          if (moneyFields.has(c.field)) {
            return `${label}: ${renderMoney(c.from)} → ${renderMoney(c.to)}`;
          }
          if (c.field === "score") {
            return `${label}: ${c.from ?? "—"} → ${c.to}`;
          }
          if (c.field === "stage" || c.field === "heat") {
            return `${label}: ${c.from ?? "—"} → ${c.to}`;
          }
          if (c.field === "dueDate" || c.field === "registeredDate") {
            const d = (v: unknown) => v ? new Date(String(v)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
            return `${label}: ${d(c.from)} → ${d(c.to)}`;
          }
          if (c.field === "description" || c.field === "paymentProofUrl") {
            // long text — just say "set" / "cleared" / "updated"
            const had = c.from != null && c.from !== "";
            const has = c.to   != null && c.to   !== "";
            if (!had && has) return `${label}: added`;
            if ( had && !has) return `${label}: cleared`;
            return `${label}: updated`;
          }
          return `${label}: ${fmtVal(c.from)} → ${fmtVal(c.to)}`;
        });
        const detail = lines.join("\n");
        const summaryFields = changes.map((c) => c.field);

        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', 'You', 'Edit',
                  ${detail}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, fields: summaryFields, changes })}::jsonb,
                  NOW())
        `);
      }

      // Re-fetch the lead in the same shape /leads returns
      const r = await db.execute(sql`
        SELECT wi.id, wi.number, p.name, l.score, l.heat, l.stage, l.stage_label AS "stageLabel"
        FROM lead l JOIN work_item wi ON wi.id = l.work_item_id JOIN party p ON p.id = wi.party_id
        WHERE wi.id = ${wiId}
      `);
      return { kind: "ok" as const, lead: r.rows[0] };
    });

    if (updated === null) return res.status(404).json({ error: "Lead not found" });
    if (updated.kind === "bad-score") return res.status(400).json({ error: "score must be 0..100" });
    res.json({ ok: true, lead: updated.lead });
  } catch (err) {
    next(err);
  }
});

// ─── POST /leads/:idOrNumber/notes — add a free-text note (timeline row) ──

leadsRouter.post("/:idOrNumber/notes", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const wiRow = await db.execute(
        isUuid
          ? sql`SELECT id, party_id FROM work_item WHERE id = ${idOrNumber} AND type = 'lead'`
          : sql`SELECT id, party_id FROM work_item WHERE number = ${idOrNumber} AND type = 'lead'`,
      );
      if (!wiRow.rows[0]) return null;
      const wiId = (wiRow.rows[0] as { id: string }).id;
      const partyId = (wiRow.rows[0] as { party_id: string }).party_id;
      const r = await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', 'You', 'Note',
                ${text}, 'you',
                ${JSON.stringify({ when: "Just now", quote: null, kind: "note" })}::jsonb, NOW())
        RETURNING id
      `);
      return r.rows[0];
    });
    if (!result) return res.status(404).json({ error: "Lead not found" });
    res.status(201).json({ ok: true, id: (result as { id: string }).id });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /leads/:idOrNumber/notes/:activityId — edit a note in place ────
//
// Updates the activity row's body. Records the edit history in payload.edits
// so we never lose the previous text. Timeline order is preserved (we don't
// touch ts), but the row's `updatedAt` is exposed so the UI can show "edited".
leadsRouter.patch("/:idOrNumber/notes/:activityId", async (req, res, next) => {
  try {
    const { idOrNumber, activityId } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    if (!/^[0-9a-fA-F-]{36}$/.test(activityId)) {
      return res.status(400).json({ error: "invalid activity id" });
    }
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const result = await withTenant(req.tenantId!, async (db) => {
      // Resolve work_item to scope the search (and reject cross-lead edits)
      const wiRow = await db.execute(
        isUuid
          ? sql`SELECT id FROM work_item WHERE id = ${idOrNumber} AND type = 'lead'`
          : sql`SELECT id FROM work_item WHERE number = ${idOrNumber} AND type = 'lead'`,
      );
      if (!wiRow.rows[0]) return { kind: "lead-missing" as const };
      const wiId = (wiRow.rows[0] as { id: string }).id;

      // Load the note. Must be a note row attached to this lead.
      const cur = await db.execute(sql`
        SELECT id, detail, payload, ts, verb
        FROM activity
        WHERE id = ${activityId} AND work_item_id = ${wiId}
      `);
      if (!cur.rows[0]) return { kind: "not-found" as const };
      const row = cur.rows[0] as {
        id: string; detail: string;
        payload: { kind?: string; edits?: Array<{ at: string; previous: string }> };
        ts: string; verb: string;
      };
      // Only allow editing rows that originated as notes.
      const isNote = row.verb === "Note" || row.payload?.kind === "note";
      if (!isNote) return { kind: "not-note" as const };

      // No-op if text didn't change
      if (text === row.detail) return { kind: "noop" as const };

      // Append-only edit history kept inside the same payload.
      const edits = Array.isArray(row.payload?.edits) ? row.payload.edits : [];
      const nextPayload = {
        ...row.payload,
        kind: "note",
        edits: [...edits, { at: new Date().toISOString(), previous: row.detail }],
      };

      await db.execute(sql`
        UPDATE activity
        SET detail = ${text},
            payload = ${JSON.stringify(nextPayload)}::jsonb
        WHERE id = ${activityId}
      `);

      return { kind: "ok" as const };
    });

    if (result.kind === "lead-missing") return res.status(404).json({ error: "Lead not found" });
    if (result.kind === "not-found")    return res.status(404).json({ error: "Note not found" });
    if (result.kind === "not-note")     return res.status(400).json({ error: "Activity is not an editable note" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /leads/:idOrNumber/comms — log an email or schedule a follow-up ─

leadsRouter.post("/:idOrNumber/comms", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);
    const kind = String(req.body?.kind ?? "");
    if (!["email", "schedule"].includes(kind)) return res.status(400).json({ error: "kind must be email|schedule" });
    const subject = req.body?.subject ? String(req.body.subject).trim() : null;
    const body    = req.body?.body    ? String(req.body.body).trim()    : null;
    const when    = req.body?.when    ? String(req.body.when).trim()    : null; // ISO date for schedule

    if (kind === "email" && !body) return res.status(400).json({ error: "body required for email" });
    if (kind === "schedule" && !when) return res.status(400).json({ error: "when required for schedule" });

    const result = await withTenant(req.tenantId!, async (db) => {
      const wiRow = await db.execute(
        isUuid
          ? sql`SELECT id, party_id FROM work_item WHERE id = ${idOrNumber} AND type = 'lead'`
          : sql`SELECT id, party_id FROM work_item WHERE number = ${idOrNumber} AND type = 'lead'`,
      );
      if (!wiRow.rows[0]) return null;
      const wiId = (wiRow.rows[0] as { id: string }).id;
      const partyId = (wiRow.rows[0] as { party_id: string }).party_id;

      if (kind === "email") {
        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', 'You', 'Email',
                  ${subject ? `${subject}\n\n${body}` : body}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, kind: "email", subject })}::jsonb, NOW())
        `);
      } else {
        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', 'You', 'Scheduled',
                  ${`Follow-up scheduled for ${when}${subject ? ` — ${subject}` : ""}.`}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, kind: "schedule", scheduledAt: when, subject })}::jsonb, NOW())
        `);
      }
      return { ok: true };
    });
    if (!result) return res.status(404).json({ error: "Lead not found" });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
