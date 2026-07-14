// One-shot backfill for the 287 leads imported from Today UpdatedLeads.xlsx.
// The original import wrote the FULL raw phone into party.phone AND a
// greedily-sliced country-code into party.phone_country_code (e.g. "+918" +
// "+918237966156"). Both fields need to be rewritten with the correctly-split
// values.
//
// We identify the imported parties via the `identifiers.imported` tag the
// import script stamps onto every party.identifiers JSONB.
//
// Dry-run by default; pass --apply to commit.
//
// Usage:
//   $env:DATABASE_URL='postgres://decrm_admin:...@.../decrm_prod?sslmode=require'
//   npx tsx src/db/backfill-imported-phones.ts            # dry-run
//   npx tsx src/db/backfill-imported-phones.ts --apply    # commit

import { pool } from "./client.js";

const APPLY = process.argv.includes("--apply");

// Same split logic as the fixed import script.
const KNOWN_CCS = [
  "+971","+974","+966","+91","+92","+94","+61","+65","+66",
  "+44","+33","+49","+34","+39","+31","+41","+46","+45","+1",
];

function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toString().replace(/[^\d+]/g, "");
  return cleaned || null;
}

function splitCountryCode(phone: string | null): { cc: string | null; local: string | null } {
  if (!phone) return { cc: null, local: null };
  if (phone.startsWith("+")) {
    for (const cc of KNOWN_CCS) {
      if (phone.startsWith(cc) && phone.length > cc.length) return { cc, local: phone.slice(cc.length) };
    }
    const m = /^(\+\d{1,3})(\d{6,15})$/.exec(phone);
    if (m) return { cc: m[1]!, local: m[2]! };
  } else if (/^\d{10}$/.test(phone)) {
    return { cc: "+91", local: phone };
  }
  return { cc: null, local: phone };
}

async function main() {
  // Read the currently-wrong values and figure out what they SHOULD be.
  // The bug produced two shapes:
  //   (a) phone_country_code starts with '+' and length > 2 (real CC + extra digits)
  //       and party.phone contains the entire "+91XXXXXXXXXX" string.
  //   (b) some legacy rows had phone stored as-typed with no cc; leave those alone.
  //
  // Regardless of which shape a row is in, the source of truth is party.phone —
  // we run the FIXED splitter against it and rewrite BOTH columns.
  const r = await pool.query<{ id: string; name: string; phone: string | null; phone_country_code: string | null }>(
    `SELECT id, name, phone, phone_country_code
       FROM party
      WHERE identifiers ? 'imported'
        AND phone IS NOT NULL`,
  );
  console.log(`  ${r.rows.length} imported parties with a phone value`);

  interface Update { id: string; name: string; oldPhone: string; oldCc: string | null; newPhone: string | null; newCc: string | null }
  const updates: Update[] = [];
  const unchanged: Update[] = [];

  for (const row of r.rows) {
    // The phone column already contains the "full" number in the buggy rows
    // (e.g. "+918237966156"). Run the fixed splitter against that.
    const normalised = normalisePhone(row.phone);
    const { cc: newCc, local } = splitCountryCode(normalised);
    // If we couldn't extract a CC we still normalise the phone column itself
    // (strip stray characters). Falls back to normalised value.
    const newPhone = local ?? normalised;

    const oldEntry = {
      id: row.id, name: row.name,
      oldPhone: row.phone!, oldCc: row.phone_country_code,
      newPhone, newCc,
    };
    if (newPhone === row.phone && newCc === row.phone_country_code) {
      unchanged.push(oldEntry);
    } else {
      updates.push(oldEntry);
    }
  }

  console.log(`  to update:   ${updates.length}`);
  console.log(`  already ok:  ${unchanged.length}`);
  console.log(`\n=== Sample updates (first 5) ===`);
  for (const u of updates.slice(0, 5)) {
    console.log(`  ${u.name.padEnd(28)} phone: "${u.oldPhone}" → "${u.newPhone}"    cc: "${u.oldCc ?? ""}" → "${u.newCc ?? ""}"`);
  }

  if (!APPLY) {
    console.log(`\n(dry-run — nothing changed. Re-run with --apply to commit.)`);
    await pool.end();
    return;
  }

  console.log(`\n→ applying ${updates.length} updates in one transaction…`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // RLS: tenant guc.
    const t = await client.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at DESC LIMIT 1`);
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [t.rows[0]!.id]);

    for (const u of updates) {
      await client.query(
        `UPDATE party SET phone = $2, phone_country_code = $3 WHERE id = $1`,
        [u.id, u.newPhone, u.newCc],
      );
    }
    await client.query("COMMIT");
    console.log(`✓ updated ${updates.length} party rows`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("✗ backfill failed:", (err as Error).message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
