// Throwaway: dump every FK that references work_item or party, along with
// on-delete action. Feeds the wipe script's cleanup order.
import { pool } from "./client.js";

async function main() {
  const q = async (target: string) => pool.query<{
    from_table: string; from_col: string; on_delete: string; conname: string;
  }>(
    `SELECT con.conname, cl.relname AS from_table, att.attname AS from_col,
            con.confdeltype AS on_delete
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class rcl ON rcl.oid = con.confrelid
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE con.contype = 'f' AND rcl.relname = $1
      ORDER BY cl.relname, att.attname`,
    [target],
  );

  const wi = await q("work_item");
  console.log(`\n=== FKs -> work_item (${wi.rows.length}) ===`);
  for (const r of wi.rows) console.log(`  ${r.from_table}.${r.from_col}  on_delete=${r.on_delete}`);

  const p = await q("party");
  console.log(`\n=== FKs -> party (${p.rows.length}) ===`);
  for (const r of p.rows) console.log(`  ${r.from_table}.${r.from_col}  on_delete=${r.on_delete}`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
