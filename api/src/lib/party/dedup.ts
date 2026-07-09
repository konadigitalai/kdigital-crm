// Phase 4 Party Model — duplicate detection + merge engine.
//
// Two capabilities:
//
//   scanForDuplicates(db, tenantId)
//     Reads every enabled party_match_rule for the tenant, executes it,
//     inserts new (a, b) pairs into party_duplicate_candidate with
//     ON CONFLICT DO NOTHING on the pending-uniq partial index. Returns a
//     summary of what was found.
//
//   mergeParties(db, tenantId, winnerId, loserId, mergedByPartyId, note)
//     Reparents every FK that points at loserId to winnerId, then flips the
//     loser's is_merged=true. Writes a party_merge_log row with a snapshot.
//     Rejects merges that would violate the app_user 1:1 invariant.
//
// All FK columns that reference party.id are listed in REPARENT_MAP. If
// you add a new party FK anywhere, add its (table, column) here too or
// merges will silently orphan those rows.
//
// Ordering: run reparents from tables with unique-index collisions FIRST
// (contact_point, party_role, party_affiliation) so the collision resolvers
// can pick the winner's row and delete the loser's. Everything else is a
// simple UPDATE.

import { sql, type SQL } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exec = { execute: (q: SQL) => Promise<any> };

// ─── REPARENT_MAP — every FK into party ──────────────────────────────────
// Kept sorted: unique-index-bearing tables at the top (handled specially
// below), plain edges below (simple UPDATE loser → winner).
//
// Discovered via `pg_constraint WHERE confrelid = 'party'::regclass`; if you
// add a new party FK anywhere, add its (table, column) here.
const REPARENT_MAP: Array<{ table: string; column: string }> = [
  // Plain edges — safe to bulk UPDATE.
  { table: "activity",                 column: "party_id" },
  { table: "activity",                 column: "actor_party_id" },
  { table: "audit_log",                column: "actor_party_id" },
  { table: "approval",                 column: "decided_by" },
  { table: "attachment",               column: "party_id" },
  { table: "batch_assignment",         column: "party_id" },
  { table: "calendar_event",           column: "organizer_id" },
  { table: "calendar_invitee",         column: "user_id" },
  { table: "cohort",                   column: "trainer_id" },
  { table: "cohort",                   column: "co_trainer_id" },
  { table: "course_assignment",        column: "party_id" },
  { table: "edify_chat_message",       column: "user_id" },
  { table: "edify_chat_session",       column: "user_id" },
  { table: "enrolment",                column: "party_id" },
  { table: "forecast_snapshot",        column: "generated_by" },
  { table: "lead",                     column: "advisor_id" },
  { table: "leave_day",                column: "user_id" },
  { table: "party",                    column: "parent_party_id" },
  { table: "party_external_id",        column: "party_id" },
  { table: "saved_view",               column: "owner_id" },
  { table: "support_case",             column: "created_by_id" },
  { table: "support_case",             column: "party_id" },
  { table: "work_item",                column: "assignee_id" },
  { table: "work_item",                column: "party_id" },
];

export interface ScanResult {
  inserted: number;
  ruleBreakdown: Record<string, number>;
}

// ─── scanForDuplicates ────────────────────────────────────────────────────

/**
 * Run every enabled party_match_rule for this tenant, insert new candidate
 * pairs into party_duplicate_candidate. Idempotent — ON CONFLICT DO NOTHING
 * on the partial unique (tenant, a, b) WHERE status='pending'.
 *
 * Excludes:
 *   - parties already merged (party.is_merged = true)
 *   - the sentinel party (party.is_system = true)
 *   - self-matches (party_a_id < party_b_id enforced by CHECK)
 */
export async function scanForDuplicates(
  db: Exec, tenantId: string,
): Promise<ScanResult> {
  const rulesR = await db.execute(sql`
    SELECT id, kind, config FROM party_match_rule
    WHERE tenant_id = ${tenantId} AND enabled = true
  `);
  const rules = rulesR.rows as Array<{ id: string; kind: string; config: Record<string, unknown> }>;

  const ruleBreakdown: Record<string, number> = {};
  let totalInserted = 0;

  for (const rule of rules) {
    let inserted = 0;
    switch (rule.kind) {
      case "exact_external_id": {
        const r = await db.execute(sql`
          INSERT INTO party_duplicate_candidate (
            tenant_id, party_a_id, party_b_id, matched_by_rule_id, score, evidence, status
          )
          SELECT DISTINCT
            ${tenantId}::uuid,
            LEAST(a.party_id, b.party_id),
            GREATEST(a.party_id, b.party_id),
            ${rule.id}::uuid,
            (100)::numeric,
            jsonb_build_object('system', a.system, 'external_id', a.external_id),
            'pending'
          FROM party_external_id a
          JOIN party_external_id b ON a.system = b.system AND a.external_id = b.external_id
          JOIN party pa ON pa.id = a.party_id
          JOIN party pb ON pb.id = b.party_id
          WHERE a.party_id < b.party_id
            AND a.tenant_id = ${tenantId} AND b.tenant_id = ${tenantId}
            AND pa.is_merged = false AND pb.is_merged = false
            AND pa.is_system = false AND pb.is_system = false
          ON CONFLICT (tenant_id, party_a_id, party_b_id) WHERE status = 'pending'
          DO NOTHING
          RETURNING id
        `);
        inserted = r.rows.length;
        break;
      }

      case "exact_email":
      case "e164_phone": {
        const kindFilter = rule.kind === "exact_email"
          ? sql`a.kind = 'email'`
          : sql`a.kind IN ('phone','whatsapp')`;
        const r = await db.execute(sql`
          INSERT INTO party_duplicate_candidate (
            tenant_id, party_a_id, party_b_id, matched_by_rule_id, score, evidence, status
          )
          SELECT DISTINCT
            ${tenantId}::uuid,
            LEAST(a.party_id, b.party_id),
            GREATEST(a.party_id, b.party_id),
            ${rule.id}::uuid,
            (${rule.kind === "exact_email" ? 90 : 85})::numeric,
            jsonb_build_object('kind', a.kind, 'value', a.value),
            'pending'
          FROM contact_point a
          JOIN contact_point b ON a.value = b.value AND a.kind = b.kind
          JOIN party pa ON pa.id = a.party_id
          JOIN party pb ON pb.id = b.party_id
          WHERE a.party_id < b.party_id
            AND a.tenant_id = ${tenantId} AND b.tenant_id = ${tenantId}
            AND a.valid_to IS NULL AND b.valid_to IS NULL
            AND ${kindFilter}
            AND pa.is_merged = false AND pb.is_merged = false
            AND pa.is_system = false AND pb.is_system = false
          ON CONFLICT (tenant_id, party_a_id, party_b_id) WHERE status = 'pending'
          DO NOTHING
          RETURNING id
        `);
        inserted = r.rows.length;
        break;
      }

      case "fuzzy_name_city": {
        const threshold = typeof rule.config?.pg_trgm_threshold === "number"
          ? rule.config.pg_trgm_threshold : 0.7;
        const r = await db.execute(sql`
          INSERT INTO party_duplicate_candidate (
            tenant_id, party_a_id, party_b_id, matched_by_rule_id, score, evidence, status
          )
          SELECT DISTINCT
            ${tenantId}::uuid,
            LEAST(pa.id, pb.id),
            GREATEST(pa.id, pb.id),
            ${rule.id}::uuid,
            (similarity(pa.name, pb.name) * 100)::numeric(5,2),
            jsonb_build_object('a_name', pa.name, 'b_name', pb.name, 'city', pa.city, 'similarity', similarity(pa.name, pb.name)),
            'pending'
          FROM party pa
          JOIN party pb ON pa.id < pb.id
                       AND pa.tenant_id = pb.tenant_id
                       AND pa.city IS NOT NULL AND pb.city IS NOT NULL
                       AND LOWER(pa.city) = LOWER(pb.city)
                       AND similarity(pa.name, pb.name) >= ${threshold}
          WHERE pa.tenant_id = ${tenantId}
            AND pa.is_merged = false AND pb.is_merged = false
            AND pa.is_system = false AND pb.is_system = false
            AND pa.kind = 'person' AND pb.kind = 'person'
          ON CONFLICT (tenant_id, party_a_id, party_b_id) WHERE status = 'pending'
          DO NOTHING
          RETURNING id
        `);
        inserted = r.rows.length;
        break;
      }

      default:
        // Unknown rule kind — surface loudly but don't crash the scan.
        console.warn(`[dedup] unknown match rule kind: ${rule.kind}`);
    }
    ruleBreakdown[rule.kind] = (ruleBreakdown[rule.kind] ?? 0) + inserted;
    totalInserted += inserted;
  }

  return { inserted: totalInserted, ruleBreakdown };
}

// ─── mergeParties ─────────────────────────────────────────────────────────

export interface MergeResult {
  logId: string;
  reparented: Record<string, number>;
}

/**
 * Reparent every FK from loser → winner, mark loser is_merged=true, log to
 * party_merge_log. All writes happen through `db` so callers can wrap in
 * their own transaction (recommended).
 *
 * Preconditions (checked here, throws Error if violated):
 *   - winner and loser are in the same tenant
 *   - neither is already merged
 *   - the app_user 1:1 invariant is preserved: if loser has an app_user
 *     row (there's an app_user whose party_id = loser), winner must NOT
 *     also have one — we won't collapse two internal users automatically.
 *   - winner ≠ loser
 */
export async function mergeParties(
  db: Exec,
  tenantId: string,
  winnerId: string,
  loserId: string,
  mergedByPartyId: string | null,
  note: string | null,
): Promise<MergeResult> {
  if (winnerId === loserId) {
    throw new Error("merge: winner and loser must differ");
  }

  // ── Preflight ──
  const preflight = await db.execute(sql`
    SELECT
      (SELECT tenant_id FROM party WHERE id = ${winnerId}) AS winner_tenant,
      (SELECT tenant_id FROM party WHERE id = ${loserId})  AS loser_tenant,
      (SELECT is_merged FROM party WHERE id = ${winnerId}) AS winner_merged,
      (SELECT is_merged FROM party WHERE id = ${loserId})  AS loser_merged,
      (SELECT is_system FROM party WHERE id = ${winnerId}) AS winner_system,
      (SELECT is_system FROM party WHERE id = ${loserId})  AS loser_system,
      (SELECT count(*)::int FROM app_user WHERE party_id = ${winnerId}) AS winner_app_user_count,
      (SELECT count(*)::int FROM app_user WHERE party_id = ${loserId})  AS loser_app_user_count
  `);
  const pf = preflight.rows[0] as {
    winner_tenant: string | null; loser_tenant: string | null;
    winner_merged: boolean | null; loser_merged: boolean | null;
    winner_system: boolean | null; loser_system: boolean | null;
    winner_app_user_count: number; loser_app_user_count: number;
  };
  if (!pf.winner_tenant || !pf.loser_tenant) {
    throw new Error("merge: one or both parties not found");
  }
  if (pf.winner_tenant !== tenantId || pf.loser_tenant !== tenantId) {
    throw new Error("merge: parties must be in the same tenant as the caller");
  }
  if (pf.winner_merged || pf.loser_merged) {
    throw new Error("merge: at least one party is already merged");
  }
  if (pf.winner_system || pf.loser_system) {
    throw new Error("merge: cannot merge the sentinel party");
  }
  if (pf.winner_app_user_count > 0 && pf.loser_app_user_count > 0) {
    throw new Error("merge: both parties back an app_user; internal users must be merged manually via Auth0");
  }

  // ── Snapshot the loser before we mutate anything ──
  const snapR = await db.execute(sql`SELECT * FROM party WHERE id = ${loserId}`);
  const loserRow = snapR.rows[0] as Record<string, unknown>;

  // ── Handle collision-prone reparents first ──
  const reparented: Record<string, number> = {};

  // contact_point — partial unique on (tenant_id, party_id, kind) WHERE is_primary=true.
  // If both winner and loser have a primary of the same kind, the loser's must be
  // demoted first (or the UPDATE would violate the constraint).
  await db.execute(sql`
    UPDATE contact_point
    SET is_primary = false
    WHERE party_id = ${loserId}
      AND kind IN (
        SELECT kind FROM contact_point WHERE party_id = ${winnerId} AND is_primary = true
      )
      AND is_primary = true
  `);
  const cpR = await db.execute(sql`
    UPDATE contact_point SET party_id = ${winnerId}
    WHERE party_id = ${loserId} RETURNING id
  `);
  reparented["contact_point"] = cpR.rows.length;

  // party_role — unique on (party_id, role, valid_from). If the loser has a
  // role row on the same (role, valid_from) as the winner, drop the loser's.
  const roleCollide = await db.execute(sql`
    DELETE FROM party_role l
    WHERE l.party_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM party_role w
        WHERE w.party_id = ${winnerId}
          AND w.role = l.role
          AND w.valid_from = l.valid_from
      )
    RETURNING id
  `);
  const roleR = await db.execute(sql`
    UPDATE party_role SET party_id = ${winnerId}
    WHERE party_id = ${loserId} RETURNING id
  `);
  reparented["party_role"] = roleR.rows.length;
  reparented["party_role_deleted_dupes"] = roleCollide.rows.length;

  // party_affiliation — partial unique (primary_uniq) on (tenant_id,
  // person_party_id) WHERE is_primary AND valid_to IS NULL. Demote loser's
  // primary if winner also has one.
  await db.execute(sql`
    UPDATE party_affiliation
    SET is_primary = false
    WHERE person_party_id = ${loserId}
      AND is_primary = true AND valid_to IS NULL
      AND EXISTS (
        SELECT 1 FROM party_affiliation
        WHERE person_party_id = ${winnerId} AND is_primary = true AND valid_to IS NULL
      )
  `);
  // Also skip any affiliation row that would become self-referential
  // (person and org both point at winner after reparent). Delete these.
  await db.execute(sql`
    DELETE FROM party_affiliation
    WHERE person_party_id = ${loserId} AND org_party_id = ${winnerId}
  `);
  await db.execute(sql`
    DELETE FROM party_affiliation
    WHERE person_party_id = ${winnerId} AND org_party_id = ${loserId}
  `);
  // Now the "person" side.
  const affPersonR = await db.execute(sql`
    UPDATE party_affiliation SET person_party_id = ${winnerId}
    WHERE person_party_id = ${loserId} RETURNING id
  `);
  // And the "org" side.
  const affOrgR = await db.execute(sql`
    UPDATE party_affiliation SET org_party_id = ${winnerId}
    WHERE org_party_id = ${loserId} RETURNING id
  `);
  reparented["party_affiliation"] = affPersonR.rows.length + affOrgR.rows.length;

  // party_consent — partial unique on (tenant_id, party_id, channel) WHERE valid_to IS NULL.
  // If both have a current row for the same channel, end-date the loser's.
  await db.execute(sql`
    UPDATE party_consent
    SET valid_to = CURRENT_DATE, updated_at = NOW()
    WHERE party_id = ${loserId}
      AND valid_to IS NULL
      AND channel IN (
        SELECT channel FROM party_consent WHERE party_id = ${winnerId} AND valid_to IS NULL
      )
  `);
  const consentR = await db.execute(sql`
    UPDATE party_consent SET party_id = ${winnerId}
    WHERE party_id = ${loserId} RETURNING id
  `);
  reparented["party_consent"] = consentR.rows.length;

  // party_external_id — unique (tenant_id, system, external_id). If loser
  // has an external_id already owned by winner in the same system, drop it.
  const extCollide = await db.execute(sql`
    DELETE FROM party_external_id l
    WHERE l.party_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM party_external_id w
        WHERE w.party_id = ${winnerId}
          AND w.system = l.system AND w.external_id = l.external_id
      )
    RETURNING id
  `);
  reparented["party_external_id_deleted_dupes"] = extCollide.rows.length;

  // course_assignment / batch_assignment — each has UNIQUE (party_id, course_id/cohort_id).
  await db.execute(sql`
    DELETE FROM course_assignment l
    WHERE l.party_id = ${loserId}
      AND EXISTS (SELECT 1 FROM course_assignment w
                  WHERE w.party_id = ${winnerId} AND w.course_id = l.course_id)
  `);
  await db.execute(sql`
    DELETE FROM batch_assignment l
    WHERE l.party_id = ${loserId}
      AND EXISTS (SELECT 1 FROM batch_assignment w
                  WHERE w.party_id = ${winnerId} AND w.cohort_id = l.cohort_id)
  `);

  // calendar_invitee — pk on (event_id, user_id). Delete collisions.
  await db.execute(sql`
    DELETE FROM calendar_invitee l
    WHERE l.user_id = ${loserId}
      AND EXISTS (SELECT 1 FROM calendar_invitee w
                  WHERE w.user_id = ${winnerId} AND w.event_id = l.event_id)
  `);

  // leave_day — unique (user_id, date). Delete collisions.
  await db.execute(sql`
    DELETE FROM leave_day l
    WHERE l.user_id = ${loserId}
      AND EXISTS (SELECT 1 FROM leave_day w
                  WHERE w.user_id = ${winnerId} AND w.date = l.date)
  `);

  // ── Plain reparent for every remaining edge ──
  // Skip the ones we handled above.
  const HANDLED = new Set([
    "contact_point.party_id",
    "party_role.party_id",
    "party_affiliation.person_party_id",
    "party_affiliation.org_party_id",
    "party_consent.party_id",
    "party_external_id.party_id",
  ]);
  for (const { table, column } of REPARENT_MAP) {
    const key = `${table}.${column}`;
    if (HANDLED.has(key)) continue;
    const r = await db.execute(sql`
      UPDATE ${sql.raw(table)} SET ${sql.raw(column)} = ${winnerId}
      WHERE ${sql.raw(column)} = ${loserId}
      RETURNING 1
    `);
    if (r.rows.length > 0) reparented[key] = r.rows.length;
  }

  // ── Also reparent party_external_id (plain edge — the collide check
  // above only deleted dupes; the rest need reparenting).
  const extR = await db.execute(sql`
    UPDATE party_external_id SET party_id = ${winnerId}
    WHERE party_id = ${loserId} RETURNING id
  `);
  reparented["party_external_id"] = extR.rows.length;

  // ── Mark loser as merged ──
  await db.execute(sql`
    UPDATE party
    SET is_merged = true,
        merged_into_party_id = ${winnerId},
        merged_at = NOW()
    WHERE id = ${loserId}
  `);

  // ── Update any pending duplicate candidate rows referencing this pair ──
  const canonA = winnerId < loserId ? winnerId : loserId;
  const canonB = winnerId < loserId ? loserId  : winnerId;
  await db.execute(sql`
    UPDATE party_duplicate_candidate
    SET status = 'merged', resolved_at = NOW(), resolved_by_party_id = ${mergedByPartyId}
    WHERE tenant_id = ${tenantId}
      AND party_a_id = ${canonA} AND party_b_id = ${canonB}
      AND status = 'pending'
  `);

  // ── Log the merge ──
  const snapshot = { loser: loserRow, reparented };
  const logR = await db.execute(sql`
    INSERT INTO party_merge_log (
      tenant_id, winner_party_id, loser_party_id, merged_by_party_id, snapshot, note
    )
    VALUES (${tenantId}, ${winnerId}, ${loserId}, ${mergedByPartyId},
            ${sql`${JSON.stringify(snapshot)}::jsonb`}, ${note ?? null})
    RETURNING id
  `);
  const logId = (logR.rows[0] as { id: string }).id;

  return { logId, reparented };
}
