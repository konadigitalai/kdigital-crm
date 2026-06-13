// Forecast Agent — aggregates the tenant's pipeline and revenue numbers
// deterministically in SQL, then asks Claude for a tight forecast briefing.
// The result is persisted in `forecast_snapshot` so the home card and the
// agent detail page can render the latest snapshot without re-calling Claude.

import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { callClaude } from "../lib/llm.js";
import { runAgent } from "./run.js";

// ── Probability priors per rating ───────────────────────────────────────
// Used to compute the rating-weighted pipeline. Tunable later — we may
// derive these from historical conversion rates per tenant.
const RATING_PROB: Record<string, number> = {
  "new lead": 0.05,
  "attempted": 0.10,
  "cold": 0.05,
  "warm": 0.20,
  "hot": 0.45,
  "superhot": 0.75,
  "enrolled": 1.0,
};

// ── Output shapes ───────────────────────────────────────────────────────

interface ForecastNumbers {
  generatedAt: string;
  totals: {
    activeLeads: number;
    enrolledLast30d: number;
    parsedPipelineINR: number;
    weightedPipelineINR: number;
    collectedFeeINR: number;
    feeDueINR: number;
  };
  ratingFunnel: Array<{ rating: string; count: number; parsedValueINR: number }>;
  byProgram: Array<{
    programId: string;
    programName: string;
    price: number | null;
    leadsByRating: Record<string, number>;
    enrolments: number;
    enrolmentsLast30d: number;
    expectedFromOpenLeadsINR: number;
  }>;
  cohorts: Array<{
    cohortId: string;
    cohortName: string;
    programName: string | null;
    seats: number | null;
    assigned: number;
    startDate: string | null;
    fillPct: number | null;
    status: string;
  }>;
  atRisk: {
    silent7d: number;
    overdueFees: number;
    missingProgram: number;
  };
  topOpenLeads: Array<{
    number: string;
    name: string;
    program: string | null;
    rating: string;
    score: number | null;
    parsedValueINR: number;
    daysSinceLastTouch: number | null;
  }>;
}

interface ForecastNarrative {
  headline: string;
  healthSummary: string;
  risks: Array<{ title: string; detail: string; severity: "low" | "med" | "high" }>;
  opportunities: Array<{ title: string; detail: string }>;
  priorityLeads: Array<{ leadNumber: string; reason: string }>;
  monthTargetReadout: string;
}

export interface ForecastSnapshot {
  generatedAt: string;
  numbers: ForecastNumbers;
  narrative: ForecastNarrative;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

// ── SQL aggregator ──────────────────────────────────────────────────────

// Reusable parsed-value expression. Reused several times below.
//   ₹1.49L → 149000 ; ₹2.4Cr → 24000000 ; ₹99k → 99000 ; otherwise 0
const parsedValueExpr = sql`
  CASE
    WHEN l.value ~ '^₹[0-9.]+L$'  THEN (regexp_replace(l.value, '[₹L]', '', 'g'))::numeric * 100000
    WHEN l.value ~ '^₹[0-9.]+Cr$' THEN (regexp_replace(l.value, '[₹Cr]', '', 'g'))::numeric * 10000000
    WHEN l.value ~ '^₹[0-9.]+k$'  THEN (regexp_replace(l.value, '[₹k]', '', 'g'))::numeric * 1000
    ELSE 0
  END
`;

async function aggregate(tenantId: string): Promise<ForecastNumbers> {
  return await withTenant(tenantId, async (db) => {
    // ── Totals + funnel
    const totalsR = await db.execute(sql`
      WITH parsed AS (
        SELECT
          l.work_item_id,
          l.rating,
          l.fee_paid,
          l.fee_due,
          ${parsedValueExpr} AS parsed_value
        FROM lead l
      )
      SELECT
        COUNT(*) FILTER (WHERE rating <> 'enrolled')::int AS "activeLeads",
        COALESCE(SUM(parsed_value) FILTER (WHERE rating <> 'enrolled'), 0)::numeric AS "parsedPipelineINR",
        COALESCE(SUM(fee_paid), 0)::numeric AS "collectedFeeINR",
        COALESCE(SUM(fee_due) FILTER (WHERE rating <> 'enrolled'), 0)::numeric AS "feeDueINR"
      FROM parsed
    `);
    const totals0 = totalsR.rows[0] as Record<string, unknown>;

    const funnelR = await db.execute(sql`
      SELECT
        l.rating AS rating,
        COUNT(*)::int AS count,
        COALESCE(SUM(${parsedValueExpr}), 0)::numeric AS "parsedValueINR"
      FROM lead l
      GROUP BY l.rating
    `);
    const ratingFunnel = (funnelR.rows as Array<{ rating: string; count: number; parsedValueINR: string }>).map(
      (r) => ({ rating: r.rating, count: Number(r.count), parsedValueINR: Number(r.parsedValueINR) || 0 }),
    );

    // ── Weighted pipeline (computed in JS so the prior table lives in code)
    const weightedPipelineINR = ratingFunnel.reduce((acc, r) => {
      if (r.rating === "enrolled") return acc; // already realised
      const prob = RATING_PROB[r.rating] ?? 0.1;
      return acc + r.parsedValueINR * prob;
    }, 0);

    // ── Enrolment counts
    const enrolR = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS "last30d",
        COALESCE(SUM(price_paid), 0)::numeric AS "priceSum"
      FROM enrolment
    `);
    const enrolledLast30d = Number((enrolR.rows[0] as { last30d: number }).last30d);
    const enrolmentRevenue = Number((enrolR.rows[0] as { priceSum: string }).priceSum) || 0;

    // ── Per-program breakdown
    const progR = await db.execute(sql`
      SELECT
        p.id           AS "programId",
        p.name         AS "programName",
        p.price        AS price,
        json_object_agg(rating_counts.rating, rating_counts.cnt) FILTER (WHERE rating_counts.rating IS NOT NULL) AS "leadsByRating",
        (SELECT COUNT(*)::int FROM enrolment e WHERE e.program_id = p.id) AS enrolments,
        (SELECT COUNT(*)::int FROM enrolment e WHERE e.program_id = p.id AND e.created_at > NOW() - INTERVAL '30 days') AS "enrolmentsLast30d"
      FROM program p
      LEFT JOIN LATERAL (
        SELECT l.rating, COUNT(*)::int AS cnt
        FROM lead l
        WHERE l.program_id = p.id
        GROUP BY l.rating
      ) rating_counts ON true
      WHERE p.enabled = true
      GROUP BY p.id, p.name, p.price
      ORDER BY p.name
    `);
    const byProgram = (progR.rows as Array<Record<string, unknown>>).map((row) => {
      const leadsByRating = (row.leadsByRating as Record<string, number> | null) ?? {};
      const price = row.price == null ? null : Number(row.price);
      // Expected revenue from open leads on this program: price × prob × count, summed
      let expected = 0;
      if (price != null) {
        for (const [rating, cnt] of Object.entries(leadsByRating)) {
          if (rating === "enrolled") continue;
          const prob = RATING_PROB[rating] ?? 0.1;
          expected += price * prob * Number(cnt);
        }
      }
      return {
        programId: row.programId as string,
        programName: row.programName as string,
        price,
        leadsByRating,
        enrolments: Number(row.enrolments) || 0,
        enrolmentsLast30d: Number(row.enrolmentsLast30d) || 0,
        expectedFromOpenLeadsINR: Math.round(expected),
      };
    });

    // ── Cohort fill (active cohorts only)
    const cohortR = await db.execute(sql`
      SELECT
        c.id           AS "cohortId",
        c.name         AS "cohortName",
        p.name         AS "programName",
        c.seats        AS seats,
        (SELECT COUNT(DISTINCT ba.party_id)::int
         FROM batch_assignment ba
         WHERE ba.cohort_id = c.id) AS assigned,
        c.start_date   AS "startDate",
        c.status       AS status
      FROM cohort c
      LEFT JOIN course co ON co.id = c.course_id
      LEFT JOIN program p ON p.id = co.program_id
      WHERE c.enabled = true AND c.status IN ('upcoming','running')
      ORDER BY c.start_date NULLS LAST
      LIMIT 12
    `);
    const cohorts = (cohortR.rows as Array<Record<string, unknown>>).map((row) => {
      const seats = row.seats == null ? null : Number(row.seats);
      const assigned = Number(row.assigned) || 0;
      const fillPct = seats && seats > 0 ? Math.round((assigned / seats) * 100) : null;
      return {
        cohortId: row.cohortId as string,
        cohortName: row.cohortName as string,
        programName: (row.programName as string | null) ?? null,
        seats,
        assigned,
        startDate: row.startDate ? new Date(row.startDate as string).toISOString().slice(0, 10) : null,
        fillPct,
        status: row.status as string,
      };
    });

    // ── At-risk counts
    const atRiskR = await db.execute(sql`
      WITH last_act AS (
        SELECT a.work_item_id, MAX(a.ts) AS last_ts FROM activity a GROUP BY a.work_item_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM lead l
          LEFT JOIN last_act la ON la.work_item_id = l.work_item_id
          WHERE l.rating IN ('hot','superhot')
            AND (la.last_ts IS NULL OR la.last_ts < NOW() - INTERVAL '7 days')
        ) AS "silent7d",
        (SELECT COUNT(*)::int FROM lead l
          WHERE l.rating <> 'enrolled'
            AND l.fee_due IS NOT NULL
            AND l.fee_due > 0
            AND l.due_date IS NOT NULL
            AND l.due_date < CURRENT_DATE
        ) AS "overdueFees",
        (SELECT COUNT(*)::int FROM lead l WHERE l.rating <> 'enrolled' AND l.program_id IS NULL) AS "missingProgram"
    `);
    const ar = atRiskR.rows[0] as Record<string, unknown>;

    // ── Top open leads (for Claude to pick priority leads from)
    const topR = await db.execute(sql`
      WITH last_act AS (
        SELECT a.work_item_id, MAX(a.ts) AS last_ts FROM activity a GROUP BY a.work_item_id
      )
      SELECT
        wi.number,
        p.name,
        l.program,
        l.rating,
        l.score,
        ${parsedValueExpr} AS "parsedValueINR",
        EXTRACT(EPOCH FROM (NOW() - la.last_ts)) / 86400 AS "daysSinceLastTouch"
      FROM lead l
      JOIN work_item wi ON wi.id = l.work_item_id
      JOIN party p      ON p.id  = wi.party_id
      LEFT JOIN last_act la ON la.work_item_id = l.work_item_id
      WHERE l.rating <> 'enrolled'
      ORDER BY
        CASE l.rating
          WHEN 'superhot' THEN 0
          WHEN 'hot'      THEN 1
          WHEN 'warm'     THEN 2
          WHEN 'attempted' THEN 3
          WHEN 'new lead' THEN 4
          ELSE 5
        END,
        l.score DESC NULLS LAST
      LIMIT 25
    `);
    const topOpenLeads = (topR.rows as Array<Record<string, unknown>>).map((row) => ({
      number: row.number as string,
      name: row.name as string,
      program: (row.program as string | null) ?? null,
      rating: row.rating as string,
      score: row.score == null ? null : Number(row.score),
      parsedValueINR: Number(row.parsedValueINR) || 0,
      daysSinceLastTouch: row.daysSinceLastTouch == null ? null : Math.round(Number(row.daysSinceLastTouch)),
    }));

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        activeLeads: Number(totals0.activeLeads) || 0,
        enrolledLast30d,
        parsedPipelineINR: Math.round(Number(totals0.parsedPipelineINR) || 0),
        weightedPipelineINR: Math.round(weightedPipelineINR),
        collectedFeeINR: Math.round((Number(totals0.collectedFeeINR) || 0) + enrolmentRevenue),
        feeDueINR: Math.round(Number(totals0.feeDueINR) || 0),
      },
      ratingFunnel: ratingFunnel.map((r) => ({ ...r, parsedValueINR: Math.round(r.parsedValueINR) })),
      byProgram,
      cohorts,
      atRisk: {
        silent7d: Number(ar.silent7d) || 0,
        overdueFees: Number(ar.overdueFees) || 0,
        missingProgram: Number(ar.missingProgram) || 0,
      },
      topOpenLeads,
    };
  });
}

// ── Claude prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a sales-pipeline analyst for an EdTech CRM (Digital Edify).
Given a deterministic snapshot of the tenant's pipeline and revenue numbers,
write a tight forecast briefing.

Hard rules:
- headline: ONE sentence for the home card. Mention the weighted pipeline OR
  enrolment progress concretely. <= 120 chars.
- healthSummary: 2-3 sentences for the detail page. Plain English; what's
  good, what's mediocre, what's a problem. No buzzwords.
- risks: 0-4 items. severity ∈ {"low","med","high"}. Cite a NUMBER from the
  input. e.g. "₹2L of fees overdue across 3 leads".
- opportunities: 0-3 items. Cite a NUMBER too. e.g. "3 superhot leads worth
  ₹4.5L combined are within reach".
- priorityLeads: 3-5 items, picked from the supplied "topOpenLeads" list.
  Each leadNumber MUST appear verbatim in the input. The reason is a SHORT
  fragment (<= 90 chars) that says why this lead in particular.
- monthTargetReadout: ONE line, e.g. "Currently at ₹6L collected · 12
  enrolments in last 30 days". If no monthly target is supplied, just
  describe what's been collected. <= 120 chars.

Hard rules continued:
- NEVER invent numbers. Every cited number must appear in the input.
- Lead numbers must be from the input list, not made up.
- Do not write "leverage", "synergy", "best-in-class". Stick to plain English.

Output JSON: {"headline": string, "healthSummary": string,
  "risks": [{"title": string, "detail": string, "severity": string}],
  "opportunities": [{"title": string, "detail": string}],
  "priorityLeads": [{"leadNumber": string, "reason": string}],
  "monthTargetReadout": string }`;

function buildUserPrompt(numbers: ForecastNumbers): string {
  const fmtINR = (n: number) => `₹${(n).toLocaleString("en-IN")}`;
  const f = numbers.totals;
  const funnel = numbers.ratingFunnel
    .map((r) => `  - ${r.rating}: ${r.count} leads · ${fmtINR(r.parsedValueINR)} parsed value`)
    .join("\n");
  const programs = numbers.byProgram
    .slice(0, 8)
    .map((p) => {
      const ratingMix = Object.entries(p.leadsByRating).map(([r, c]) => `${r}:${c}`).join(", ") || "no leads";
      return `  - ${p.programName}${p.price ? ` (₹${Number(p.price).toLocaleString("en-IN")})` : ""}: ${ratingMix}; ${p.enrolments} enrolled (${p.enrolmentsLast30d} in 30d); expected from open ≈ ${fmtINR(p.expectedFromOpenLeadsINR)}`;
    })
    .join("\n");
  const cohorts = numbers.cohorts
    .map((c) => `  - ${c.cohortName} (${c.programName ?? "no program"}): ${c.assigned}/${c.seats ?? "?"} seats${c.fillPct != null ? ` (${c.fillPct}% full)` : ""} · status ${c.status}${c.startDate ? ` · starts ${c.startDate}` : ""}`)
    .join("\n");
  const top = numbers.topOpenLeads
    .map((l) => `  - ${l.number} · ${l.name} · ${l.program ?? "—"} · ${l.rating} · score ${l.score ?? "?"} · value ${fmtINR(l.parsedValueINR)} · ${l.daysSinceLastTouch == null ? "no touch logged" : `last touch ${l.daysSinceLastTouch}d ago`}`)
    .join("\n");

  return `Pipeline snapshot · ${numbers.generatedAt}

Totals:
- Active (non-enrolled) leads:        ${f.activeLeads}
- Parsed pipeline (sum of value):     ${fmtINR(f.parsedPipelineINR)}
- Rating-weighted pipeline:           ${fmtINR(f.weightedPipelineINR)}
- Fees collected (incl. enrolments):  ${fmtINR(f.collectedFeeINR)}
- Fees due (open leads):              ${fmtINR(f.feeDueINR)}
- Enrolments in last 30 days:         ${f.enrolledLast30d}

Rating funnel:
${funnel || "  (no leads)"}

Per-program breakdown (top 8):
${programs || "  (no programs)"}

Active cohorts:
${cohorts || "  (no active cohorts)"}

At-risk counts:
- Hot/superhot leads silent 7+ days:  ${numbers.atRisk.silent7d}
- Leads with fees past due:            ${numbers.atRisk.overdueFees}
- Open leads with no program set:      ${numbers.atRisk.missingProgram}

Top open leads (pick 3-5 priority leads from this list):
${top || "  (no open leads)"}

Task: write the forecast briefing as JSON.`;
}

function validate(o: unknown, allowedLeadNumbers: Set<string>): ForecastNarrative {
  const x = o as Record<string, unknown>;
  if (!x || typeof x !== "object") throw new Error("Forecast output not an object");
  const headline = String(x.headline ?? "").trim();
  const healthSummary = String(x.healthSummary ?? "").trim();
  const monthTargetReadout = String(x.monthTargetReadout ?? "").trim();
  if (!headline) throw new Error("headline empty");
  if (!healthSummary) throw new Error("healthSummary empty");

  const risks = Array.isArray(x.risks) ? x.risks : [];
  const opps  = Array.isArray(x.opportunities) ? x.opportunities : [];
  const leads = Array.isArray(x.priorityLeads) ? x.priorityLeads : [];

  const cleanRisks = (risks as unknown[])
    .map((r) => {
      const rr = r as Record<string, unknown>;
      const title = String(rr.title ?? "").trim();
      const detail = String(rr.detail ?? "").trim();
      const sev = String(rr.severity ?? "med").toLowerCase();
      const severity: "low" | "med" | "high" = sev === "high" ? "high" : sev === "low" ? "low" : "med";
      if (!title || !detail) return null;
      return { title, detail, severity };
    })
    .filter((r): r is { title: string; detail: string; severity: "low" | "med" | "high" } => r !== null);

  const cleanOpps = (opps as unknown[])
    .map((o) => {
      const oo = o as Record<string, unknown>;
      const title = String(oo.title ?? "").trim();
      const detail = String(oo.detail ?? "").trim();
      if (!title || !detail) return null;
      return { title, detail };
    })
    .filter((o): o is { title: string; detail: string } => o !== null);

  const cleanLeads = (leads as unknown[])
    .map((l) => {
      const ll = l as Record<string, unknown>;
      const leadNumber = String(ll.leadNumber ?? "").trim();
      const reason = String(ll.reason ?? "").trim();
      if (!leadNumber || !reason) return null;
      if (!allowedLeadNumbers.has(leadNumber)) return null; // drop fabricated numbers
      return { leadNumber, reason };
    })
    .filter((l): l is { leadNumber: string; reason: string } => l !== null)
    .slice(0, 5);

  return {
    headline,
    healthSummary,
    risks: cleanRisks,
    opportunities: cleanOpps,
    priorityLeads: cleanLeads,
    monthTargetReadout,
  };
}

// ── Main entry ──────────────────────────────────────────────────────────

export async function runForecast(
  tenantId: string,
  generatedBy: string | null,
): Promise<ForecastSnapshot> {
  // Step 1: aggregate (deterministic, runs outside runAgent so we can include
  // the result in the run's "target" string).
  const numbers = await aggregate(tenantId);

  const { result, runWorkItemId } = await runAgent({
    tenantId,
    agentKey: "forecast",
    target: `${Math.round(numbers.totals.weightedPipelineINR / 100000) / 10}L weighted pipeline`,
    steps: [
      { label: "aggregate", state: "queued" },
      { label: "narrate", state: "queued" },
      { label: "write_back", state: "queued" },
    ],
    body: async ({ beginStep, endStep, db }) => {
      beginStep("aggregate");
      endStep(`${numbers.totals.activeLeads} active leads · ₹${Math.round(numbers.totals.weightedPipelineINR/100000)/10}L weighted`);

      beginStep("narrate");
      const out = await callClaude({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(numbers),
        expectJson: true,
        maxTokens: 1500,
      });
      const allowed = new Set(numbers.topOpenLeads.map((l) => l.number));
      const narrative = validate(out.jsonValue, allowed);
      endStep(`${out.usage.in}+${out.usage.out} tokens`);

      beginStep("write_back");
      await db.execute(sql`
        INSERT INTO forecast_snapshot (
          tenant_id, numbers, narrative, model, tokens_in, tokens_out, generated_by
        ) VALUES (
          ${tenantId},
          ${JSON.stringify(numbers)}::jsonb,
          ${JSON.stringify(narrative)}::jsonb,
          ${out.model},
          ${out.usage.in},
          ${out.usage.out},
          ${generatedBy}
        )
      `);

      // Activity row + audit log so the timeline + audit trail capture this.
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, actor_type, actor_name, verb, detail, tag, icon_key, icon_bg, icon_stroke, payload, ts
        ) VALUES (
          ${tenantId}, 'agent', 'Forecast Agent',
          'generated forecast', ${narrative.headline.slice(0, 200)},
          'auto', 'chart',
          'rgba(198,154,58,.10)', '#C69A3A',
          ${JSON.stringify({ subject: "tenant pipeline", weightedPipelineINR: numbers.totals.weightedPipelineINR })}::jsonb,
          NOW()
        )
      `);

      await db.execute(sql`
        INSERT INTO audit_log (tenant_id, actor_type, action, target_type, context)
        VALUES (
          ${tenantId}, 'agent', 'forecast_generated', 'tenant',
          ${JSON.stringify({ weightedPipelineINR: numbers.totals.weightedPipelineINR, model: out.model, tokensIn: out.usage.in, tokensOut: out.usage.out })}::jsonb
        )
      `);

      endStep("done");
      return {
        narrative,
        model: out.model,
        tokensIn: out.usage.in,
        tokensOut: out.usage.out,
      };
    },
  });

  void runWorkItemId;
  return {
    generatedAt: numbers.generatedAt,
    numbers,
    narrative: result.narrative,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
}

export async function getLatestForecast(tenantId: string): Promise<ForecastSnapshot | null> {
  return await withTenant(tenantId, async (db) => {
    const r = await db.execute(sql`
      SELECT
        generated_at AS "generatedAt",
        numbers, narrative,
        model, tokens_in AS "tokensIn", tokens_out AS "tokensOut"
      FROM forecast_snapshot
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0] as Record<string, unknown>;
    return {
      generatedAt: new Date(row.generatedAt as string).toISOString(),
      numbers: row.numbers as ForecastNumbers,
      narrative: row.narrative as ForecastNarrative,
      model: (row.model as string | null) ?? null,
      tokensIn: (row.tokensIn as number | null) ?? null,
      tokensOut: (row.tokensOut as number | null) ?? null,
    };
  });
}
