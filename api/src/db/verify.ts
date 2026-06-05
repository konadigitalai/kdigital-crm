// Sanity queries after seed — counts, a join, pending approval, RLS check.
import { pool } from "./client.js";

async function main() {
  // 1. Counts per table — quick health view
  const counts = await pool.query<{ tbl: string; n: string }>(`
    SELECT 'tenant'      AS tbl, count(*)::text AS n FROM tenant
    UNION ALL SELECT 'app_user',     count(*)::text FROM app_user
    UNION ALL SELECT 'party',        count(*)::text FROM party
    UNION ALL SELECT 'party_role',   count(*)::text FROM party_role
    UNION ALL SELECT 'program',      count(*)::text FROM program
    UNION ALL SELECT 'cohort',       count(*)::text FROM cohort
    UNION ALL SELECT 'work_item',    count(*)::text FROM work_item
    UNION ALL SELECT 'lead',         count(*)::text FROM lead
    UNION ALL SELECT 'agent',        count(*)::text FROM agent
    UNION ALL SELECT 'agent_run',    count(*)::text FROM agent_run
    UNION ALL SELECT 'activity',     count(*)::text FROM activity
    UNION ALL SELECT 'approval',     count(*)::text FROM approval
    ORDER BY tbl
  `);
  console.log("\n── Row counts ─────────────────────────");
  for (const r of counts.rows) console.log(`  ${r.tbl.padEnd(14)} ${r.n.padStart(4)}`);

  // 2. Sample join — top hot leads with their party + work_item number
  const hot = await pool.query<{ number: string; name: string; city: string; score: number; stage: string; nba: string }>(`
    SELECT wi.number, p.name, l.city, l.score, l.stage_label AS stage, l.nba_label AS nba
    FROM lead l
    JOIN work_item wi ON wi.id = l.work_item_id
    JOIN party p      ON p.id  = wi.party_id
    WHERE l.heat = 'hot'
    ORDER BY l.score DESC
    LIMIT 5
  `);
  console.log("\n── Top 5 hot leads ────────────────────");
  for (const r of hot.rows) {
    console.log(`  ${r.number}  ${r.name.padEnd(16)} ${String(r.score).padStart(3)}  ${r.stage.padEnd(14)}  ${r.nba}`);
  }

  // 3. Pending approval (the dark NBA card)
  const ap = await pool.query<{ number: string; name: string; action_type: string; mode: string; status: string }>(`
    SELECT wi.number, p.name, a.action_type, a.mode, a.status
    FROM approval a
    JOIN work_item wi ON wi.id = a.work_item_id
    JOIN party p      ON p.id  = wi.party_id
    WHERE a.status = 'pending'
  `);
  console.log("\n── Pending approvals ──────────────────");
  for (const r of ap.rows) {
    console.log(`  ${r.number}  ${r.name.padEnd(16)} ${r.action_type.padEnd(16)} ${r.mode.padEnd(12)} ${r.status}`);
  }

  // 4. RLS smoke test — without app.tenant_id GUC, the escape hatch lets us through.
  //    Set a fake tenant id and confirm we see ZERO rows.
  console.log("\n── RLS check ──────────────────────────");
  const c = await pool.connect();
  try {
    await c.query(`SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'`);
    const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM lead`);
    const ok = r.rows[0]!.n === "0";
    console.log(`  fake tenant sees ${r.rows[0]!.n} leads — ${ok ? "✓ RLS isolating" : "✗ RLS LEAKING"}`);
  } finally {
    c.release();
  }

  // 5. Active agent run cards (what the home page grid will show)
  const runs = await pool.query<{ name: string; status: string; metric: string; pill: string }>(`
    SELECT a.name, ar.status, ar.metric_value || ' ' || ar.metric_label AS metric, ar.right_pill AS pill
    FROM agent_run ar
    JOIN agent a ON a.tenant_id = ar.tenant_id AND a.key = ar.agent_key
    ORDER BY ar.live DESC, a.name
  `);
  console.log("\n── Agent runs ─────────────────────────");
  for (const r of runs.rows) {
    console.log(`  ${r.name.padEnd(22)} ${r.status.padEnd(10)} ${r.metric.padEnd(20)} ${r.pill}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
