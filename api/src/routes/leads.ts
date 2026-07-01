import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { emitEvent } from "../lib/events.js";
import { requirePermission } from "../middleware/require.js";
import { partyIdFromAppUserId, resolveActorPartyId, resolveSentinelPartyId } from "../lib/party/resolve.js";

export const leadsRouter = Router();

// Human-readable label for an edit-diff field. Used by PATCH /leads to render
// activity rows like "Score: 65 → 78" rather than dumping camelCase keys.
function humanFieldLabel(field: string): string {
  const map: Record<string, string> = {
    name: "Name",
    email: "Email",
    phone: "Phone",
    phoneCountryCode: "Phone country code",
    city: "City",
    timeZone: "Time zone",
    deliveryMode: "Delivery mode",
    value: "Price quoted",
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
    nextFollowupAt: "Next follow-up date",
    demoAttendedAt: "Demo attended date",
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
    const rating = b.rating ? String(b.rating) : "new lead";
    if (!["new lead","attempted","cold","warm","hot","superhot","enrolled"].includes(rating)) {
      errors.push("rating invalid");
    }
    const nbaLabel = b.nbaLabel ? String(b.nbaLabel).trim() : "Reach out today";
    const nbaIcon  = b.nbaIcon  ? String(b.nbaIcon).trim()  : "send";
    const advisorId = b.advisorId ? String(b.advisorId).trim() : null;

    if (errors.length) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      // Phase 3: every activity/audit row we write below gets actor_party_id.
      // The seeded rows in the timeline are `actor_type='user'` (advisor) and
      // `actor_type='ai'`; the ai ones use sentinel, user ones use req.userId.
      const userActorPartyId  = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const agentActorPartyId = await resolveSentinelPartyId(db, req.tenantId!);

      // Resolve advisor: explicit id wins; otherwise pick first admin.
      // Phase 2 Party Model: work_item.assignee_id / lead.advisor_id both
      // reference party.id now. The client sends an app_user.id — resolve.
      let resolvedAdvisorId: string | null = null;
      if (advisorId) {
        resolvedAdvisorId = await partyIdFromAppUserId(db, advisorId);
      } else {
        const r = await db.execute(sql`
          SELECT party_id FROM app_user WHERE role = 'admin' AND active = true ORDER BY created_at LIMIT 1
        `);
        resolvedAdvisorId = (r.rows[0] as { party_id: string } | undefined)?.party_id ?? null;
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

      // Phase 1 Party Model dual-write — mirror email/phone into contact_point.
      // `source` is a category enum (web / instagram_ad / referral…), NOT a
      // per-party external ID, so it does NOT go into party_external_id.
      // Genuine external IDs (Instagram lead id, Razorpay customer id) will be
      // inserted by their respective integrations once wired.
      if (email) {
        await db.execute(sql`
          INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
          VALUES (current_tenant(), ${partyId}, 'email', ${email}, 'primary', true)
        `);
      }
      if (phone) {
        await db.execute(sql`
          INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
          VALUES (current_tenant(), ${partyId}, 'phone', ${phone}, 'primary', true)
        `);
      }

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
          source, source_label, score, score_label, score_desc, heat, rating,
          program, program_id, value, stage, stage_label,
          advisor_id, avatar, initials,
          nba_icon, nba_label, nba_ghost,
          nba_confidence, nba_headline, nba_why
        ) VALUES (
          ${wiId}, current_tenant(),
          ${source}, ${sourceLabel}, ${score}, ${HEAT_LABEL[heat]}, ${HEAT_DESC[heat]}, ${heat}, ${rating},
          ${programName}, ${resolvedProgramId}, ${value}, ${stage}, ${STAGE_LABEL[stage]},
          ${resolvedAdvisorId}, ${pickAvatar(name)}, ${initialsOf(name)},
          ${nbaIcon}, ${nbaLabel}, false,
          ${nba.confidence}, ${nba.headline}, ${nba.why}
        )
        -- Phase 3: lead.city dropped; city lives on party only.
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
        // Phase 3: pick sentinel for ai/agent/system, otherwise the acting user.
        const actorPartyId = r.actorType === "user" ? userActorPartyId : agentActorPartyId;
        await db.execute(sql`
          INSERT INTO activity (
            tenant_id, work_item_id, party_id,
            actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts
          ) VALUES (
            current_tenant(), ${wiId}, ${partyId},
            ${r.actorType}, ${actorPartyId}, ${r.actorName}, ${r.verb}, ${r.detail}, ${r.tag},
            ${JSON.stringify({ when: fmt(ts), quote: null })}::jsonb,
            ${ts.toISOString()}
          )
        `);
      }

      // Resolve advisor name for the outbound event payload (cheap; same tx).
      let advisorName: string | null = null;
      if (resolvedAdvisorId) {
        const u = await db.execute(sql`SELECT name FROM app_user WHERE party_id = ${resolvedAdvisorId}`);
        advisorName = (u.rows[0] as { name: string } | undefined)?.name ?? null;
      }

      return { id: wiId, number, advisorName };
    });

    // Fire Slack notifications post-commit so a webhook outage can't 500
    // the request. emitEvent never throws.
    await emitEvent({
      type: "lead.created",
      tenantId: req.tenantId!,
      occurredAt: new Date().toISOString(),
      context: {
        leadId: result.id,
        number: result.number,
        name,
        email,
        phone,
        city,
        program: programName,
        source,
        sourceLabel,
        advisorName: result.advisorName,
        stage,
        score,
        heat,
        rating,
      },
    });

    res.status(201).json({ lead: { id: result.id, number: result.number } });
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
      //
      // SELECT mirrors GET /pipeline so the /leads grid (which reuses the
      // same column registry) can render every editable column. Previously
      // this endpoint returned a slim shape and contact fields like phone,
      // email, advisor, source rendered as "—" in the grid.
      const r = await db.execute(sql`
        SELECT
          wi.id              AS id,
          wi.number          AS number,
          wi.created_at      AS "createdAt",
          p.name             AS name,
          p.email            AS email,
          p.phone            AS phone,
          p.phone_country_code AS "phoneCountryCode",
          l.initials         AS initials,
          p.city             AS city,             -- Phase 3: was l.city (denorm dropped)
          l.program          AS program,
          l.program_id       AS "programId",
          l.value            AS value,
          l.description      AS description,
          l.stage            AS stage,
          l.stage_label      AS "stageLabel",
          l.score            AS score,
          l.heat             AS heat,
          l.rating           AS rating,
          l.avatar           AS avatar,
          l.nba_icon         AS "nbaIcon",
          l.nba_label        AS "nbaLabel",
          l.nba_ghost        AS "nbaGhost",
          l.next_followup_at AS "nextFollowupAt",
          l.demo_attended_at AS "demoAttendedAt",
          l.delivery_mode    AS "deliveryMode",
          l.time_zone        AS "timeZone",
          l.fee_paid         AS "feePaid",
          l.fee_due          AS "feeDue",
          l.due_date         AS "dueDate",
          l.registered_date  AS "registeredDate",
          l.source           AS source,
          l.source_label     AS "sourceLabel",
          au.id              AS "advisorId",  -- app_user.id for wire compat (l.advisor_id stores party.id)
          au.name            AS "advisorName"
        FROM lead l
        JOIN work_item wi ON wi.id = l.work_item_id
        JOIN party p      ON p.id  = wi.party_id
        LEFT JOIN app_user au ON au.party_id = l.advisor_id
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
    if (b.rating !== undefined && !["new lead","attempted","cold","warm","hot","superhot","enrolled"].includes(String(b.rating))) {
      return res.status(400).json({ error: "rating invalid" });
    }

    const actorName = req.user?.name?.trim() || "You";
    const actorId   = req.userId ?? null;

    const updated = await withTenant(req.tenantId!, async (db) => {
      // Phase 3: resolve actor once per handler for every activity row below.
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, actorId);

      // Resolve work_item by id or number AND fetch current values so we can
      // compute a *real diff* — only fields that actually changed get logged.
      const beforeR = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id, wi.party_id AS "partyId",
                     p.name, p.email, p.phone, p.phone_country_code AS "phoneCountryCode", p.city,
                     l.value, l.source, l.source_label AS "sourceLabel", l.description,
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.next_followup_at AS "nextFollowupAt",
                     l.demo_attended_at AS "demoAttendedAt",
                     l.time_zone AS "timeZone",
                     l.delivery_mode AS "deliveryMode",
                     l.payment_proof_url AS "paymentProofUrl",
                     l.score, l.heat, l.stage, l.stage_label AS "stageLabel",
                     l.nba_label AS "nbaLabel", l.nba_icon AS "nbaIcon",
                     (SELECT au.id FROM app_user au WHERE au.party_id = l.advisor_id LIMIT 1) AS "advisorId",
                     l.program_id AS "programId", l.program AS "programName"
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              JOIN lead  l ON l.work_item_id = wi.id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'lead'
            `
          : sql`
              SELECT wi.id, wi.party_id AS "partyId",
                     p.name, p.email, p.phone, p.phone_country_code AS "phoneCountryCode", p.city,
                     l.value, l.source, l.source_label AS "sourceLabel", l.description,
                     l.fee_paid AS "feePaid", l.fee_due AS "feeDue",
                     l.due_date AS "dueDate", l.registered_date AS "registeredDate",
                     l.next_followup_at AS "nextFollowupAt",
                     l.demo_attended_at AS "demoAttendedAt",
                     l.time_zone AS "timeZone",
                     l.delivery_mode AS "deliveryMode",
                     l.payment_proof_url AS "paymentProofUrl",
                     l.score, l.heat, l.stage, l.stage_label AS "stageLabel",
                     l.nba_label AS "nbaLabel", l.nba_icon AS "nbaIcon",
                     (SELECT au.id FROM app_user au WHERE au.party_id = l.advisor_id LIMIT 1) AS "advisorId",
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
        const v = norm(b.email);
        await db.execute(sql`UPDATE party SET email = ${v} WHERE id = ${partyId}`);
        // Phase 1 dual-write. Partial unique index (tenant_id, party_id, kind)
        // WHERE is_primary matches post-0040-contact-point.sql.
        if (v) {
          await db.execute(sql`
            INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
            VALUES (current_tenant(), ${partyId}, 'email', ${v}, 'primary', true)
            ON CONFLICT (tenant_id, party_id, kind) WHERE is_primary
            DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `);
        } else {
          // email cleared → mark the primary email row as historical (not deleted).
          await db.execute(sql`
            UPDATE contact_point SET valid_to = CURRENT_DATE, is_primary = false, updated_at = now()
            WHERE tenant_id = current_tenant() AND party_id = ${partyId}
              AND kind = 'email' AND is_primary = true
          `);
        }
      }
      if (b.phone !== undefined) {
        const v = norm(b.phone);
        await db.execute(sql`UPDATE party SET phone = ${v} WHERE id = ${partyId}`);
        if (v) {
          await db.execute(sql`
            INSERT INTO contact_point (tenant_id, party_id, kind, value, label, is_primary)
            VALUES (current_tenant(), ${partyId}, 'phone', ${v}, 'primary', true)
            ON CONFLICT (tenant_id, party_id, kind) WHERE is_primary
            DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `);
        } else {
          await db.execute(sql`
            UPDATE contact_point SET valid_to = CURRENT_DATE, is_primary = false, updated_at = now()
            WHERE tenant_id = current_tenant() AND party_id = ${partyId}
              AND kind = 'phone' AND is_primary = true
          `);
        }
      }
      if (b.phoneCountryCode !== undefined) {
        // Normalize: keep only "+digits" (e.g. "+91"). Empty/invalid → null.
        const cc = b.phoneCountryCode == null || b.phoneCountryCode === ""
          ? null
          : (() => {
              const m = String(b.phoneCountryCode).trim().match(/^\+?(\d{1,4})$/);
              return m ? `+${m[1]}` : null;
            })();
        await db.execute(sql`UPDATE party SET phone_country_code = ${cc} WHERE id = ${partyId}`);
      }
      if (b.city !== undefined) {
        // Phase 3: city lives on party only (lead.city denorm dropped).
        await db.execute(sql`UPDATE party SET city = ${norm(b.city)} WHERE id = ${partyId}`);
      }

      // Build lead update (dynamic SET)
      const leadSets: ReturnType<typeof sql>[] = [];
      if (b.value !== undefined) {
        // Price quoted is now pure rupees — digits with an optional decimal.
        // Reject anything containing letters / "L" / "Cr" / "₹" / etc.
        const raw = b.value == null || b.value === "" ? null : String(b.value).trim();
        if (raw !== null && !/^\d+(\.\d+)?$/.test(raw)) {
          return { kind: "bad-value" as const };
        }
        leadSets.push(sql`value = ${raw}`);
      }
      if (b.timeZone !== undefined) leadSets.push(sql`time_zone = ${b.timeZone ? String(b.timeZone).trim() : null}`);
      if (b.deliveryMode !== undefined) {
        const m = b.deliveryMode == null || b.deliveryMode === "" ? null : String(b.deliveryMode).trim().toLowerCase();
        if (m !== null && !["online", "offline", "hybrid"].includes(m)) {
          return { kind: "bad-delivery-mode" as const };
        }
        leadSets.push(sql`delivery_mode = ${m}`);
      }
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
      if (b.rating !== undefined) leadSets.push(sql`rating = ${String(b.rating)}`);
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
      if (b.advisorId !== undefined) {
        // Phase 2: client sends app_user.id; column stores party.id.
        const partyId = b.advisorId ? await partyIdFromAppUserId(db, String(b.advisorId)) : null;
        leadSets.push(sql`advisor_id = ${partyId}`);
      }
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
      if (b.nextFollowupAt !== undefined)
        leadSets.push(sql`next_followup_at = ${b.nextFollowupAt || null}`);
      if (b.demoAttendedAt !== undefined)
        leadSets.push(sql`demo_attended_at = ${b.demoAttendedAt || null}`);
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
        ["name", "name"], ["email", "email"], ["phone", "phone"],
        ["phoneCountryCode", "phoneCountryCode"],
        ["city", "city"],
        ["value", "value"], ["description", "description"],
        ["paymentProofUrl", "paymentProofUrl"],
        ["nbaLabel", "nbaLabel"], ["nbaIcon", "nbaIcon"],
        ["timeZone", "timeZone"],
        ["deliveryMode", "deliveryMode"],
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
      for (const [in_, prev] of [
        ["dueDate", "dueDate"],
        ["registeredDate", "registeredDate"],
        ["nextFollowupAt", "nextFollowupAt"],
        ["demoAttendedAt", "demoAttendedAt"],
      ] as const) {
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
        // value/price quoted is also money when it's purely numeric.
        const renderPrice = (v: unknown): string => {
          if (v == null || v === "") return "—";
          const s = String(v).trim();
          if (/^\d+(\.\d+)?$/.test(s)) return `₹${Number(s).toLocaleString("en-IN")}`;
          return `"${s}"`;
        };

        const lines = changes.map((c) => {
          const label = humanFieldLabel(c.field);
          if (moneyFields.has(c.field)) {
            return `${label}: ${renderMoney(c.from)} → ${renderMoney(c.to)}`;
          }
          if (c.field === "value") {
            return `${label}: ${renderPrice(c.from)} → ${renderPrice(c.to)}`;
          }
          if (c.field === "score") {
            return `${label}: ${c.from ?? "—"} → ${c.to}`;
          }
          if (c.field === "stage" || c.field === "heat") {
            return `${label}: ${c.from ?? "—"} → ${c.to}`;
          }
          if (c.field === "dueDate" || c.field === "registeredDate"
              || c.field === "nextFollowupAt" || c.field === "demoAttendedAt") {
            const d = (v: unknown) => v ? new Date(String(v)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
            return `${label}: ${d(c.from)} → ${d(c.to)}`;
          }
          if (c.field === "description") {
            // Long-form text — show a truncated "from → to" so the timeline
            // tells the story without bloating the activity row. Newlines
            // are flattened so the one-line diff stays readable.
            const trim = (v: unknown): string => {
              if (v == null || v === "") return "—";
              const oneLine = String(v).replace(/\s+/g, " ").trim();
              return oneLine.length > 80
                ? `"${oneLine.slice(0, 80)}…"`
                : `"${oneLine}"`;
            };
            const had = c.from != null && c.from !== "";
            const has = c.to   != null && c.to   !== "";
            if (!had && has) return `${label}: added — ${trim(c.to)}`;
            if ( had && !has) return `${label}: cleared (was ${trim(c.from)})`;
            return `${label}: ${trim(c.from)} → ${trim(c.to)}`;
          }
          if (c.field === "paymentProofUrl") {
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
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', ${actorPartyId}, ${actorName}, 'Edit',
                  ${detail}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, fields: summaryFields, changes, byUserId: actorId })}::jsonb,
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
    if (updated.kind === "bad-delivery-mode") return res.status(400).json({ error: "deliveryMode must be online | offline | hybrid" });
    if (updated.kind === "bad-value") return res.status(400).json({ error: "Price quoted must be a number (e.g. 149000) — no letters or symbols." });
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

    const actorName = req.user?.name?.trim() || "You";
    const actorId   = req.userId ?? null;

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, actorId);
      const wiRow = await db.execute(
        isUuid
          ? sql`SELECT id, party_id FROM work_item WHERE id = ${idOrNumber} AND type = 'lead'`
          : sql`SELECT id, party_id FROM work_item WHERE number = ${idOrNumber} AND type = 'lead'`,
      );
      if (!wiRow.rows[0]) return null;
      const wiId = (wiRow.rows[0] as { id: string }).id;
      const partyId = (wiRow.rows[0] as { party_id: string }).party_id;
      const r = await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', ${actorPartyId}, ${actorName}, 'Note',
                ${text}, 'you',
                ${JSON.stringify({ when: "Just now", quote: null, kind: "note", byUserId: actorId })}::jsonb, NOW())
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

    const actorName = req.user?.name?.trim() || "You";
    const actorId   = req.userId ?? null;

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, actorId);
      // Resolve work_item to scope the search (and reject cross-lead edits)
      const wiRow = await db.execute(
        isUuid
          ? sql`SELECT id, party_id FROM work_item WHERE id = ${idOrNumber} AND type = 'lead'`
          : sql`SELECT id, party_id FROM work_item WHERE number = ${idOrNumber} AND type = 'lead'`,
      );
      if (!wiRow.rows[0]) return { kind: "lead-missing" as const };
      const wiId    = (wiRow.rows[0] as { id: string }).id;
      const partyId = (wiRow.rows[0] as { party_id: string }).party_id;

      // Load the note. Must be a note row attached to this lead.
      const cur = await db.execute(sql`
        SELECT id, detail, payload, ts, verb
        FROM activity
        WHERE id = ${activityId} AND work_item_id = ${wiId}
      `);
      if (!cur.rows[0]) return { kind: "not-found" as const };
      const row = cur.rows[0] as {
        id: string; detail: string;
        payload: { kind?: string; edits?: Array<{ at: string; previous: string; by?: string; byUserId?: string | null }> };
        ts: string; verb: string;
      };
      // Only allow editing rows that originated as notes.
      const isNote = row.verb === "Note" || row.payload?.kind === "note";
      if (!isNote) return { kind: "not-note" as const };

      // No-op if text didn't change
      if (text === row.detail) return { kind: "noop" as const };

      // Append-only edit history kept inside the same payload. We now record
      // who made each edit so the note's "edited" tooltip can show the
      // attribution alongside timestamps.
      const editedAt = new Date().toISOString();
      const edits = Array.isArray(row.payload?.edits) ? row.payload.edits : [];
      const nextPayload = {
        ...row.payload,
        kind: "note",
        edits: [
          ...edits,
          { at: editedAt, previous: row.detail, by: actorName, byUserId: actorId },
        ],
      };

      await db.execute(sql`
        UPDATE activity
        SET detail = ${text},
            payload = ${JSON.stringify(nextPayload)}::jsonb
        WHERE id = ${activityId}
      `);

      // Drop a separate activity row so the timeline shows the edit as its
      // own event with the actor's name. Detail is a one-line "from → to"
      // diff with both sides truncated so a long note doesn't bloat the
      // feed; the original note row still holds the full prior text in
      // payload.edits for anyone who wants the receipt.
      const trim = (s: string) => {
        const oneLine = s.replace(/\s+/g, " ").trim();
        return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
      };
      const detail = `Edited a note: "${trim(row.detail)}" → "${trim(text)}"`;
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name,
          verb, detail, tag, payload, ts
        ) VALUES (
          current_tenant(), ${wiId}, ${partyId}, 'user', ${actorPartyId}, ${actorName},
          'Note edited', ${detail}, 'you',
          ${JSON.stringify({
            when: "Just now",
            quote: null,
            kind: "note_edit",
            noteId: activityId,
            previous: trim(row.detail),
            next: trim(text),
            byUserId: actorId,
          })}::jsonb,
          NOW()
        )
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
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
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
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', ${actorPartyId}, 'You', 'Email',
                  ${subject ? `${subject}\n\n${body}` : body}, 'you',
                  ${JSON.stringify({ when: "Just now", quote: null, kind: "email", subject })}::jsonb, NOW())
        `);
      } else {
        await db.execute(sql`
          INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
          VALUES (current_tenant(), ${wiId}, ${partyId}, 'user', ${actorPartyId}, 'You', 'Scheduled',
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

// ─── POST /leads/bulk — apply the same patch to many leads at once ────────
//
// Body: { ids: string[]   // work_item ids (UUIDs)
//         patch: { rating?, programId?, advisorId?, source?, deliveryMode?,
//                  timeZone?, nextFollowupAt?, demoAttendedAt? } }
//
// Validation mirrors PATCH /leads/:id but is scoped to the eight bulk-safe
// fields. Per-lead failures don't abort the rest; the response tallies up
// successes and lists the IDs that errored.
leadsRouter.post("/bulk", async (req, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const patch = req.body?.patch && typeof req.body.patch === "object" ? req.body.patch as Record<string, unknown> : {};

    if (!ids.length)      return res.status(400).json({ error: "ids[] is required" });
    if (ids.length > 500) return res.status(400).json({ error: "max 500 leads per bulk update" });
    for (const id of ids) {
      if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
        return res.status(400).json({ error: "ids[] must contain UUIDs" });
      }
    }

    const ALLOWED = ["rating","programId","advisorId","source","deliveryMode","timeZone","nextFollowupAt","demoAttendedAt"];
    const unknownKeys = Object.keys(patch).filter((k) => !ALLOWED.includes(k));
    if (unknownKeys.length) {
      return res.status(400).json({ error: `unsupported bulk fields: ${unknownKeys.join(", ")}` });
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "patch is empty" });
    }
    if (patch.rating !== undefined && !["new lead","attempted","cold","warm","hot","superhot","enrolled"].includes(String(patch.rating))) {
      return res.status(400).json({ error: "rating invalid" });
    }
    if (patch.deliveryMode !== undefined && patch.deliveryMode !== null && patch.deliveryMode !== "") {
      const m = String(patch.deliveryMode).trim().toLowerCase();
      if (!["online","offline","hybrid"].includes(m)) {
        return res.status(400).json({ error: "deliveryMode must be online | offline | hybrid" });
      }
    }
    for (const k of ["programId","advisorId"] as const) {
      const v = patch[k];
      if (v !== undefined && v !== null && v !== "" && !/^[0-9a-fA-F-]{36}$/.test(String(v))) {
        return res.status(400).json({ error: `${k} must be a UUID or null` });
      }
    }
    for (const k of ["nextFollowupAt","demoAttendedAt"] as const) {
      const v = patch[k];
      if (v !== undefined && v !== null && v !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
        return res.status(400).json({ error: `${k} must be YYYY-MM-DD or null` });
      }
    }

    // Resolve labels for ID-bearing fields once up front so each per-row
    // UPDATE doesn't re-query.
    const resolved = await withTenant(req.tenantId!, async (db) => {
      const out: { programName?: string | null; sourceLabel?: string | null; advisorName?: string | null } = {};
      if (patch.programId !== undefined) {
        if (patch.programId) {
          const r = await db.execute(sql`SELECT name FROM program WHERE id = ${String(patch.programId)}`);
          out.programName = (r.rows[0] as { name: string } | undefined)?.name ?? null;
        } else {
          out.programName = null;
        }
      }
      if (patch.source !== undefined) {
        const SOURCE_LABEL: Record<string, string> = {
          web: "Website form",
          instagram_ad: "Instagram ad",
          referral: "Referral",
          webinar: "Webinar",
          paid: "Paid search",
        };
        out.sourceLabel = patch.source ? (SOURCE_LABEL[String(patch.source)] ?? String(patch.source)) : null;
      }
      if (patch.advisorId !== undefined) {
        if (patch.advisorId) {
          const r = await db.execute(sql`SELECT name FROM app_user WHERE id = ${String(patch.advisorId)}`);
          out.advisorName = (r.rows[0] as { name: string } | undefined)?.name ?? null;
        } else {
          out.advisorName = null;
        }
      }
      return out;
    });

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const updated: string[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const wiId of ids) {
        try {
          const exists = await db.execute(sql`
            SELECT 1 FROM work_item WHERE id = ${wiId} AND type = 'lead'
          `);
          if (!exists.rows.length) {
            failed.push({ id: wiId, error: "lead not found" });
            continue;
          }

          const sets: ReturnType<typeof sql>[] = [];
          if (patch.rating !== undefined)    sets.push(sql`rating = ${String(patch.rating)}`);
          if (patch.programId !== undefined) {
            sets.push(sql`program_id = ${patch.programId ? String(patch.programId) : null}`);
            if (resolved.programName !== undefined) sets.push(sql`program = ${resolved.programName}`);
          }
          if (patch.advisorId !== undefined) {
            const partyId = patch.advisorId ? await partyIdFromAppUserId(db, String(patch.advisorId)) : null;
            sets.push(sql`advisor_id = ${partyId}`);
          }
          if (patch.source !== undefined) {
            sets.push(sql`source = ${patch.source ? String(patch.source) : null}`);
            if (resolved.sourceLabel !== undefined) sets.push(sql`source_label = ${resolved.sourceLabel}`);
          }
          if (patch.deliveryMode !== undefined) {
            const m = patch.deliveryMode === null || patch.deliveryMode === ""
              ? null
              : String(patch.deliveryMode).trim().toLowerCase();
            sets.push(sql`delivery_mode = ${m}`);
          }
          if (patch.timeZone !== undefined) {
            sets.push(sql`time_zone = ${patch.timeZone ? String(patch.timeZone).trim() : null}`);
          }
          if (patch.nextFollowupAt !== undefined) {
            sets.push(sql`next_followup_at = ${patch.nextFollowupAt ? String(patch.nextFollowupAt) : null}`);
          }
          if (patch.demoAttendedAt !== undefined) {
            sets.push(sql`demo_attended_at = ${patch.demoAttendedAt ? String(patch.demoAttendedAt) : null}`);
          }

          if (sets.length === 0) {
            updated.push(wiId);
            continue;
          }

          const set = sql.join(sets, sql`, `);
          await db.execute(sql`UPDATE lead SET ${set} WHERE work_item_id = ${wiId}`);

          const fieldsTouched = Object.keys(patch).join(", ");
          await db.execute(sql`
            INSERT INTO activity (tenant_id, work_item_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
            VALUES (current_tenant(), ${wiId}, 'user', ${actorPartyId}, 'You', 'Bulk edit',
                    ${`Updated ${fieldsTouched} via bulk action`},
                    'you',
                    ${JSON.stringify({ when: "Just now", kind: "bulk-edit", fields: Object.keys(patch), patch })}::jsonb,
                    NOW())
          `);

          updated.push(wiId);
        } catch (err) {
          failed.push({ id: wiId, error: (err as Error).message });
        }
      }

      return { updated, failed };
    });

    res.json({
      ok: true,
      updated: result.updated.length,
      failed: result.failed,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /leads/deleted — list soft-deleted leads ────────────────────────
//
// Admin "Trash" view. We expose only enough fields for a recognise-and-restore
// UX: identity, who-was-the-advisor, when it was deleted, who deleted it.
// The full record is reachable via /records/:number (still loads even after
// soft-delete) — no need to duplicate everything here.
//
// Mount-level middleware gates GET behind `leads.read`. We add a stricter
// per-handler check on `leads.delete` so users who can only see active leads
// don't accidentally see the trash.
leadsRouter.get("/deleted", requirePermission("leads.delete"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          wi.id              AS id,
          wi.number          AS number,
          p.id               AS "partyId",
          p.name             AS name,
          p.email            AS email,
          p.phone            AS phone,
          l.program          AS program,
          l.source           AS source,
          l.source_label     AS "sourceLabel",
          l.score            AS score,
          l.heat             AS heat,
          l.rating           AS rating,
          u.name             AS "advisorName",
          pr.valid_to        AS "deletedAt"
        FROM party_role pr
        JOIN party p     ON p.id = pr.party_id
        JOIN work_item wi ON wi.party_id = p.id AND wi.type = 'lead'
        JOIN lead l      ON l.work_item_id = wi.id
        LEFT JOIN app_user u ON u.party_id = l.advisor_id
        WHERE pr.role = 'lead'
          AND pr.valid_to IS NOT NULL
          -- Exclude leads that were converted to learners (the convert path
          -- also end-dates the lead role, so the row looks the same as a
          -- soft-delete from the SQL alone). A current learner role on the
          -- same party is the cheap distinguishing signal.
          AND NOT EXISTS (
            SELECT 1 FROM party_role learner
            WHERE learner.party_id = p.id
              AND learner.role = 'learner'
              AND learner.valid_to IS NULL
          )
        ORDER BY pr.valid_to DESC NULLS LAST, wi.created_at DESC
      `);
      return r.rows;
    });
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST /leads/:idOrNumber/restore — undo a soft-delete ─────────────────
//
// Clears `valid_to` on the lead role. Refuses if the lead is already active
// (no-op) or if the party has since become a learner (409 — that path is
// owned by a different role flow).
//
// Gate: leads.write. The mount middleware allows POST through with leads.write,
// which matches the principle that anyone who can edit a lead can undo a
// destructive op against it.
leadsRouter.post("/:idOrNumber/restore", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id, wi.party_id AS "partyId", p.name
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'lead'
            `
          : sql`
              SELECT wi.id, wi.party_id AS "partyId", p.name
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'lead'
            `,
      );
      if (!r.rows[0]) return { kind: "not-found" as const };
      const row = r.rows[0] as { id: string; partyId: string; name: string };

      // Already a learner? Restoration would conflict with the role we expect.
      const learner = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'learner' AND valid_to IS NULL
        LIMIT 1
      `);
      if (learner.rows[0]) return { kind: "is-learner" as const };

      // Already active?
      const active = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NULL
        LIMIT 1
      `);
      if (active.rows[0]) return { kind: "already-active" as const };

      // Re-open the most-recently-closed lead role for this party.
      await db.execute(sql`
        UPDATE party_role
        SET valid_to = NULL
        WHERE id = (
          SELECT id FROM party_role
          WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NOT NULL
          ORDER BY valid_to DESC
          LIMIT 1
        )
      `);

      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${row.id}, ${row.partyId}, 'user', ${actorPartyId}, 'You', 'Restored',
                ${`Lead "${row.name}" restored.`}, 'you',
                ${JSON.stringify({ when: "Just now", kind: "restore" })}::jsonb, NOW())
      `);

      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'lead_restored', 'lead', ${row.id},
                ${JSON.stringify({ partyId: row.partyId, name: row.name })}::jsonb)
      `);

      return { kind: "ok" as const };
    });

    if (result.kind === "not-found")     return res.status(404).json({ error: "Lead not found" });
    if (result.kind === "is-learner")    return res.status(409).json({ error: "Lead has been converted to a learner; cannot be restored." });
    if (result.kind === "already-active") return res.status(409).json({ error: "Lead is already active." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /leads/:idOrNumber/purge — permanent erase ───────────────────
//
// Hard-deletes a soft-deleted lead. Removes lead row + activity rows + score
// signals + agent assignments + the work_item. The party is preserved if it
// still holds any other role (learner, alumnus, contact); otherwise the
// party + party_role rows for it cascade.
//
// Refuses if the lead is still active (must be soft-deleted first) or if the
// party has been converted to a learner (different lifecycle).
//
// Gate: leads.purge. Mount-level guard already enforces leads.delete for
// DELETE; we add a stricter per-handler check.
leadsRouter.delete("/:idOrNumber/purge", requirePermission("leads.purge"), async (req, res, next) => {
  try {
    const idOrNumber = String(req.params.idOrNumber ?? "");
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id, wi.party_id AS "partyId", p.name
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'lead'
            `
          : sql`
              SELECT wi.id, wi.party_id AS "partyId", p.name
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'lead'
            `,
      );
      if (!r.rows[0]) return { kind: "not-found" as const };
      const row = r.rows[0] as { id: string; partyId: string; name: string };

      // Refuse purge of still-active or learner-converted leads.
      const learner = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'learner' AND valid_to IS NULL
        LIMIT 1
      `);
      if (learner.rows[0]) return { kind: "is-learner" as const };

      const active = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NULL
        LIMIT 1
      `);
      if (active.rows[0]) return { kind: "still-active" as const };

      // Audit BEFORE we wipe the row so the audit_log insert can reference
      // a still-existing target_id (most schemas don't FK audit_log → work_item,
      // but doing this first is safer regardless).
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'lead_purged', 'lead', ${row.id},
                ${JSON.stringify({ partyId: row.partyId, name: row.name })}::jsonb)
      `);

      // Wipe the lead-related rows. Order matters: children first, then
      // parent. activity has work_item_id with no ON DELETE CASCADE in the
      // schema we shipped, so we delete it explicitly.
      await db.execute(sql`DELETE FROM activity WHERE work_item_id = ${row.id}`);
      await db.execute(sql`DELETE FROM agent_assignment WHERE work_item_id = ${row.id}`);
      await db.execute(sql`DELETE FROM lead_score_signal WHERE work_item_id = ${row.id}`);
      await db.execute(sql`DELETE FROM lead WHERE work_item_id = ${row.id}`);

      // Drop ALL lead party_roles for this party (active + ended).
      await db.execute(sql`
        DELETE FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'lead'
      `);

      // Finally the work_item itself.
      await db.execute(sql`DELETE FROM work_item WHERE id = ${row.id}`);

      // If the party has no remaining roles, drop the party too. This avoids
      // orphan parties cluttering search results.
      const remaining = await db.execute(sql`
        SELECT 1 FROM party_role WHERE party_id = ${row.partyId} LIMIT 1
      `);
      if (!remaining.rows[0]) {
        await db.execute(sql`DELETE FROM party WHERE id = ${row.partyId}`);
      }

      return { kind: "ok" as const };
    });

    if (result.kind === "not-found")    return res.status(404).json({ error: "Lead not found" });
    if (result.kind === "is-learner")   return res.status(409).json({ error: "Lead has been converted to a learner; cannot be purged here." });
    if (result.kind === "still-active") return res.status(409).json({ error: "Lead is still active. Soft-delete it first." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /leads/:idOrNumber — soft-delete one lead ─────────────────────
//
// "Soft delete" = end the party's `lead` role (set `valid_to = today`). The
// lead disappears from /leads, /pipeline, search; the work_item, activity,
// notes, payment trail, and party itself are preserved. A future "Restore"
// can clear valid_to.
//
// Refuses if the party has already been converted to a learner (we don't
// want a destructive op when the lead has graduated). Returns 409 in that
// case so the UI can show a useful message.
//
// Mount-level middleware (readWriteDelete in index.ts) already gates this
// behind the `leads.delete` permission.
leadsRouter.delete("/:idOrNumber", async (req, res, next) => {
  try {
    const { idOrNumber } = req.params;
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(idOrNumber);

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(
        isUuid
          ? sql`
              SELECT wi.id, wi.party_id AS "partyId", p.name
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              WHERE wi.id = ${idOrNumber} AND wi.type = 'lead'
            `
          : sql`
              SELECT wi.id, wi.party_id AS "partyId", p.name
              FROM work_item wi
              JOIN party p ON p.id = wi.party_id
              WHERE wi.number = ${idOrNumber} AND wi.type = 'lead'
            `,
      );
      if (!r.rows[0]) return { kind: "not-found" as const };
      const row = r.rows[0] as { id: string; partyId: string; name: string };

      // Already converted? lead role's valid_to is set, learner role is current.
      const learner = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'learner' AND valid_to IS NULL
        LIMIT 1
      `);
      if (learner.rows[0]) return { kind: "is-learner" as const };

      // Already deleted? lead role already end-dated.
      const active = await db.execute(sql`
        SELECT 1 FROM party_role
        WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NULL
        LIMIT 1
      `);
      if (!active.rows[0]) return { kind: "already-deleted" as const };

      // End the lead role.
      await db.execute(sql`
        UPDATE party_role
        SET valid_to = CURRENT_DATE
        WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NULL
      `);

      // Drop a timeline row so the audit trail remains visible if anyone
      // looks at /records/:id later (the work_item itself is preserved).
      await db.execute(sql`
        INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
        VALUES (current_tenant(), ${row.id}, ${row.partyId}, 'user', ${actorPartyId}, 'You', 'Deleted',
                ${`Lead "${row.name}" deleted (soft).`}, 'you',
                ${JSON.stringify({ when: "Just now", kind: "delete" })}::jsonb, NOW())
      `);

      // Audit log mirrors how case-close logs.
      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
        VALUES (current_tenant(), 'user', ${actorPartyId}, 'lead_deleted', 'lead', ${row.id},
                ${JSON.stringify({ partyId: row.partyId, name: row.name })}::jsonb)
      `);

      return { kind: "ok" as const };
    });

    if (result.kind === "not-found")       return res.status(404).json({ error: "Lead not found" });
    if (result.kind === "is-learner")      return res.status(409).json({ error: "Lead has been converted to a learner; cannot be deleted from here." });
    if (result.kind === "already-deleted") return res.status(409).json({ error: "Lead is already deleted." });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /leads/bulk-delete — soft-delete many at once ───────────────────
//
// Mirrors POST /leads/bulk's response shape: per-id outcomes, partial-failure
// tally. We add an explicit `requirePermission("leads.delete")` here because
// the mount-level guard (readWriteDelete) sees this as a POST and enforces
// `leads.write`, which is a weaker permission than what we want.
leadsRouter.post("/bulk-delete", requirePermission("leads.delete"), async (req, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];

    if (!ids.length)      return res.status(400).json({ error: "ids[] is required" });
    if (ids.length > 500) return res.status(400).json({ error: "max 500 leads per bulk delete" });
    for (const id of ids) {
      if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
        return res.status(400).json({ error: "ids[] must contain UUIDs" });
      }
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const deleted: string[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const wiId of ids) {
        try {
          const r = await db.execute(sql`
            SELECT wi.id, wi.party_id AS "partyId", p.name
            FROM work_item wi
            JOIN party p ON p.id = wi.party_id
            WHERE wi.id = ${wiId} AND wi.type = 'lead'
          `);
          const row = r.rows[0] as { id: string; partyId: string; name: string } | undefined;
          if (!row) {
            failed.push({ id: wiId, error: "lead not found" });
            continue;
          }

          const learner = await db.execute(sql`
            SELECT 1 FROM party_role
            WHERE party_id = ${row.partyId} AND role = 'learner' AND valid_to IS NULL
            LIMIT 1
          `);
          if (learner.rows[0]) {
            failed.push({ id: wiId, error: "already converted to learner" });
            continue;
          }

          const active = await db.execute(sql`
            SELECT 1 FROM party_role
            WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NULL
            LIMIT 1
          `);
          if (!active.rows[0]) {
            failed.push({ id: wiId, error: "already deleted" });
            continue;
          }

          await db.execute(sql`
            UPDATE party_role
            SET valid_to = CURRENT_DATE
            WHERE party_id = ${row.partyId} AND role = 'lead' AND valid_to IS NULL
          `);

          await db.execute(sql`
            INSERT INTO activity (tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name, verb, detail, tag, payload, ts)
            VALUES (current_tenant(), ${row.id}, ${row.partyId}, 'user', ${actorPartyId}, 'You', 'Deleted',
                    ${`Lead "${row.name}" deleted (soft, bulk action).`}, 'you',
                    ${JSON.stringify({ when: "Just now", kind: "delete-bulk" })}::jsonb, NOW())
          `);

          await db.execute(sql`
            INSERT INTO audit_log (tenant_id, actor_type, actor_party_id, action, target_type, target_id, context)
            VALUES (current_tenant(), 'user', ${actorPartyId}, 'lead_deleted', 'lead', ${row.id},
                    ${JSON.stringify({ partyId: row.partyId, name: row.name, bulk: true })}::jsonb)
          `);

          deleted.push(wiId);
        } catch (err) {
          failed.push({ id: wiId, error: (err as Error).message });
        }
      }

      return { deleted, failed };
    });

    res.json({
      ok: true,
      deleted: result.deleted.length,
      failed: result.failed,
    });
  } catch (err) {
    next(err);
  }
});
