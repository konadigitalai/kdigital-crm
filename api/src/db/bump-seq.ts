// One-shot: bump seq_lead past the highest existing LEAD-XXXX number.
// Safe to re-run.
import { pool } from "./client.js";

async function main() {
  // Drop any test leads from before the fix (numbers we know we minted)
  await pool.query(`
    DELETE FROM work_item
    WHERE type = 'lead'
      AND number IN ('LEAD-9700')
      AND created_at > NOW() - INTERVAL '30 minutes'
  `);
  // CASCADE will have removed lead/lead_score_signal/agent_assignment/activity.

  const r = await pool.query<{ next: string }>(`
    SELECT setval('seq_lead', GREATEST(
      9700,
      (SELECT MAX(NULLIF(regexp_replace(number, '\\D', '', 'g'), ''))::int
       FROM work_item WHERE type = 'lead')
    ))::text AS next
  `);
  console.log(`✓ seq_lead now at ${r.rows[0]?.next}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
