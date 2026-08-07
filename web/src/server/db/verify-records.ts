// Verify the new record-detail tables are populated.
import { pool } from "./client";

async function main() {
  const counts = await pool.query<{ tbl: string; n: string }>(`
    SELECT 'lead_score_signal' AS tbl, count(*)::text AS n FROM lead_score_signal
    UNION ALL SELECT 'agent_assignment', count(*)::text FROM agent_assignment
    UNION ALL SELECT 'activity (ai|you)', count(*)::text FROM activity WHERE tag IN ('ai','you')
    UNION ALL SELECT 'lead w/ advisor', count(*)::text FROM lead WHERE advisor_id IS NOT NULL
    UNION ALL SELECT 'lead w/ nba_*',   count(*)::text FROM lead WHERE nba_headline IS NOT NULL
    UNION ALL SELECT 'party w/ email',  count(*)::text FROM party WHERE email IS NOT NULL
    ORDER BY tbl
  `);
  console.log("\n── New table coverage ──");
  for (const r of counts.rows) console.log(`  ${r.tbl.padEnd(22)} ${r.n.padStart(4)}`);

  // Sample: Rahul Thomas
  console.log("\n── Rahul Thomas (LEAD-9701) record ──");
  const r = await pool.query<{ k: string; v: string }>(`
    SELECT 'name'    AS k, p.name           AS v FROM lead l JOIN work_item wi ON wi.id=l.work_item_id JOIN party p ON p.id=wi.party_id WHERE wi.number='LEAD-9701'
    UNION ALL SELECT 'email',   p.email FROM lead l JOIN work_item wi ON wi.id=l.work_item_id JOIN party p ON p.id=wi.party_id WHERE wi.number='LEAD-9701'
    UNION ALL SELECT 'phone',   p.phone FROM lead l JOIN work_item wi ON wi.id=l.work_item_id JOIN party p ON p.id=wi.party_id WHERE wi.number='LEAD-9701'
    UNION ALL SELECT 'source',  l.source_label FROM lead l JOIN work_item wi ON wi.id=l.work_item_id WHERE wi.number='LEAD-9701'
    UNION ALL SELECT 'advisor', u.name FROM lead l JOIN work_item wi ON wi.id=l.work_item_id LEFT JOIN app_user u ON u.id=l.advisor_id WHERE wi.number='LEAD-9701'
    UNION ALL SELECT 'nba',     l.nba_headline FROM lead l JOIN work_item wi ON wi.id=l.work_item_id WHERE wi.number='LEAD-9701'
  `);
  for (const row of r.rows) console.log(`  ${row.k.padEnd(10)} ${row.v ?? '—'}`);

  const sigs = await pool.query<{ text: string; weight: string; kind: string }>(`
    SELECT s.text, s.weight, s.kind FROM lead_score_signal s
    JOIN work_item wi ON wi.id = s.work_item_id WHERE wi.number = 'LEAD-9701' ORDER BY s.rank
  `);
  console.log("  signals:");
  for (const s of sigs.rows) console.log(`    ${s.kind.padEnd(4)} ${s.weight.padStart(8)}  ${s.text}`);

  const agents = await pool.query<{ name: string; status: string; bk: string; bl: string }>(`
    SELECT a.name, aa.status, aa.badge_kind AS bk, aa.badge_label AS bl
    FROM agent_assignment aa
    JOIN agent a       ON a.id = aa.agent_id
    JOIN work_item wi  ON wi.id = aa.work_item_id
    WHERE wi.number = 'LEAD-9701' ORDER BY aa.rank
  `);
  console.log("  agents on lead:");
  for (const a of agents.rows) console.log(`    ${a.name.padEnd(22)} ${a.bk}/${a.bl.padEnd(8)} ${a.status}`);

  const tl = await pool.query<{ by: string; verb: string; detail: string }>(`
    SELECT actor_name AS by, verb, detail FROM activity
    WHERE work_item_id = (SELECT id FROM work_item WHERE number = 'LEAD-9701')
      AND tag IN ('ai','you')
    ORDER BY ts
  `);
  console.log("  timeline:");
  for (const t of tl.rows) console.log(`    [${t.verb.padEnd(10)}] ${t.by.padEnd(20)} ${t.detail.slice(0, 60)}`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
