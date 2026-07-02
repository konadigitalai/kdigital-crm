// Phase 4 Party Model — per-channel consent helpers.
//
// Regulatory context: DPDP (India) + GDPR both require per-channel opt-in
// records for marketing communications. The party_consent table (see
// post-0050) is our record. This module is the *only* place that reads
// and writes it.
//
// Strict enforcement: unknown consent = blocked. A party is allowed on a
// channel only if a current row (valid_to IS NULL) has opt_in = true.

import { sql, type SQL } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Exec = { execute: (q: SQL) => Promise<any> };

export type Channel = "whatsapp" | "email" | "sms" | "calls";
export type ConsentState = "opt_in" | "opt_out" | "unknown";
export type BlockReason = "no_consent" | "opt_out";

/**
 * Read the current consent state for one (party, channel).
 * Returns 'unknown' if no current row exists.
 */
export async function getConsent(
  db: Exec, partyId: string, channel: Channel,
): Promise<ConsentState> {
  const r = await db.execute(sql`
    SELECT opt_in FROM party_consent
    WHERE party_id = ${partyId} AND channel = ${channel} AND valid_to IS NULL
    LIMIT 1
  `);
  const row = r.rows[0] as { opt_in: boolean } | undefined;
  if (!row) return "unknown";
  return row.opt_in ? "opt_in" : "opt_out";
}

/**
 * Set the current consent for (party, channel). End-dates any existing
 * current row and inserts a new one. Preserves history.
 *
 * Both steps run in the same connection; wrap the caller in a transaction
 * if you need atomicity across other writes.
 */
export async function setConsent(
  db: Exec,
  partyId: string,
  channel: Channel,
  optIn: boolean,
  source: string,
  evidenceUrl?: string | null,
): Promise<void> {
  // End-date the current row if any.
  await db.execute(sql`
    UPDATE party_consent
    SET valid_to = CURRENT_DATE, updated_at = NOW()
    WHERE party_id = ${partyId} AND channel = ${channel} AND valid_to IS NULL
  `);
  // Insert the new row.
  await db.execute(sql`
    INSERT INTO party_consent (tenant_id, party_id, channel, opt_in, source, evidence_url)
    VALUES (current_tenant(), ${partyId}, ${channel}, ${optIn}, ${source}, ${evidenceUrl ?? null})
  `);
}

/**
 * Bulk filter: given a list of party ids and a channel, return which ones
 * have opt_in=true and which are blocked (with reason).
 *
 * Uses party_consent_channel_optin_idx (partial WHERE valid_to IS NULL) so
 * a broadcast with 500 recipients is one indexed scan.
 */
export async function filterConsentedRecipients(
  db: Exec, channel: Channel, partyIds: string[],
): Promise<{
  allowed: string[];
  blocked: Array<{ partyId: string; reason: BlockReason }>;
}> {
  if (partyIds.length === 0) return { allowed: [], blocked: [] };
  // Validate UUIDs before splicing into SQL — party ids are trusted (from
  // our own DB) but we assert format here as defence-in-depth.
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const safe = partyIds.filter((p) => UUID_RE.test(p));
  if (safe.length === 0) return { allowed: [], blocked: [] };
  const r = await db.execute(sql`
    WITH input(party_id) AS (VALUES ${sql.raw(safe.map((p) => `('${p}'::uuid)`).join(","))})
    SELECT
      i.party_id::text                     AS party_id,
      COALESCE(pc.opt_in::text, 'unknown') AS state
    FROM input i
    LEFT JOIN party_consent pc
      ON pc.party_id = i.party_id
     AND pc.channel  = ${channel}
     AND pc.valid_to IS NULL
  `);
  const allowed: string[] = [];
  const blocked: Array<{ partyId: string; reason: BlockReason }> = [];
  for (const row of r.rows as Array<{ party_id: string; state: string }>) {
    if (row.state === "true") allowed.push(row.party_id);
    else if (row.state === "false") blocked.push({ partyId: row.party_id, reason: "opt_out" });
    else blocked.push({ partyId: row.party_id, reason: "no_consent" });
  }
  return { allowed, blocked };
}
