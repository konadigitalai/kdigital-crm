// One-shot: fix date columns on leads already imported from a Leads*.xlsx.
//
// Context: the older parseDate() in import-leads-xlsx.ts sliced UTC days,
// which shifted every Edify-exported IST-midnight timestamp (e.g.
// "2026-05-11 18:30:00 UTC" = 00:00 IST on 2026-05-12) back by a day.
// Fresh imports use the corrected parseDate. This script re-parses the
// xlsx with the corrected logic and writes the four affected date
// columns back onto the matching lead rows.
//
// SCOPE:
//   - Reads xlsx via --file (default: "../Leads july 7.xlsx")
//   - Matches by (party.name ILIKE, party.phone = local-part)
//     * Rows with no match in prod → skipped, listed in the summary
//     * Rows with multiple matches → skipped (ambiguous), listed
//   - Overwrites lead.{visited_date, visiting_date, next_followup_at,
//     demo_attended_at} with the corrected xlsx values.
//     * Overwrite ALWAYS: if the xlsx has a date, that date wins, even
//       if an advisor hand-edited it. If the xlsx cell is empty, the
//       corresponding DB column is left alone (we don't clear values).
//
// Dry-run by default. --apply to commit inside a single transaction.
//
// Usage:
//   $env:DATABASE_URL='postgres://…'
//   npx tsx src/db/backfill-visit-dates.ts
//   npx tsx src/db/backfill-visit-dates.ts --apply
//
// Nothing else is touched — descriptions, ratings, statuses, advisors,
// programs, etc. all stay as they are.

import { readFileSync } from "node:fs";
import xlsx from "xlsx";
import { pool } from "./client.js";

// ─── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fileArg = args.find((a) => a.startsWith("--file="));
const XLSX_PATH = fileArg ? fileArg.slice("--file=".length) : "../Leads july 7.xlsx";

function maskUrl(u: string): string {
  return u.replace(/(:\/\/[^:]+:)[^@]+(@)/, "$1***$2");
}

// ─── Helpers (copied from import-leads-xlsx.ts to keep this script self-contained) ──

function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toString().replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  return cleaned;
}

const KNOWN_CCS = [
  "+971", "+974", "+966",
  "+91", "+92", "+94",
  "+61", "+65", "+66",
  "+44", "+33", "+49", "+34", "+39", "+31", "+41", "+46", "+45",
  "+1",
];

function splitCountryCode(phone: string | null): { cc: string | null; local: string | null } {
  if (!phone) return { cc: null, local: null };
  if (phone.startsWith("+")) {
    for (const cc of KNOWN_CCS) {
      if (phone.startsWith(cc) && phone.length > cc.length) {
        return { cc, local: phone.slice(cc.length) };
      }
    }
    const m = /^(\+\d{1,3})(\d{6,15})$/.exec(phone);
    if (m) return { cc: m[1]!, local: m[2]! };
  } else if (/^\d{10}$/.test(phone)) {
    return { cc: "+91", local: phone };
  }
  return { cc: null, local: phone };
}

// The CORRECTED parseDate — same rule as the fixed importer:
// shift by +5:30 before slicing so IST-midnight-in-UTC produces the
// correct IST calendar day.
function parseDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────

interface Plan {
  rowNo: number;
  xlsxName: string;
  xlsxPhoneLocal: string | null;
  visitedDate: string | null;
  visitingDate: string | null;
  nextFollowupAt: string | null;
  demoAttendedAt: string | null;
}

interface Matched {
  workItemId: string;
  leadNumber: string;
  partyName: string;
  partyPhone: string | null;
  before: {
    visitedDate: string | null;
    visitingDate: string | null;
    nextFollowupAt: string | null;
    demoAttendedAt: string | null;
  };
  after: {
    visitedDate: string | null;
    visitingDate: string | null;
    nextFollowupAt: string | null;
    demoAttendedAt: string | null;
  };
}

async function main() {
  console.log(`→ target DB: ${maskUrl(process.env.DATABASE_URL ?? "(none)")}`);
  console.log(`→ xlsx:      ${XLSX_PATH}`);
  console.log(`→ mode:      ${APPLY ? "APPLY (destructive)" : "DRY-RUN"}\n`);

  const buf = readFileSync(XLSX_PATH);
  const wb = xlsx.read(buf, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets["Leads.csv"] ?? wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) throw new Error("no readable sheet in xlsx");
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: false }) as Record<string, unknown>[];
  const rowsRaw = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true }) as Record<string, unknown>[];
  console.log(`  ${rows.length} rows in xlsx\n`);

  // Tenant.
  const tenR = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  const tenant = tenR.rows[0];
  if (!tenant) throw new Error("no tenant row found");
  console.log(`  tenant: ${tenant.name} (${tenant.id})`);

  // Build the target set from the xlsx — only rows where at least one of
  // the four date columns is populated. Rows with all four blank have
  // nothing to update anyway.
  const targets: Plan[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const rRaw = rowsRaw[i] ?? {};
    const rowNo = i + 2;
    const name = (r["Full name"] ?? "").toString().trim();
    if (!name) continue;

    const phoneRawCell = rRaw["Mobile"] ?? r["Mobile"];
    const phoneRaw = phoneRawCell == null ? "" : String(phoneRawCell);
    const phoneNormal = normalisePhone(phoneRaw);
    const { local } = splitCountryCode(phoneNormal);

    const visitedDate    = parseDate(r["Visited Date"]);
    const visitingDate   = parseDate(r["Visiting Date"] ?? r["Exp Visiting Date"]);
    const nextFollowupAt = parseDate(r["Next FollowUp Date"]);
    const demoAttendedAt = parseDate(r["Demo Attended Date"]);

    if (!visitedDate && !visitingDate && !nextFollowupAt && !demoAttendedAt) continue;

    targets.push({
      rowNo,
      xlsxName: name,
      xlsxPhoneLocal: local ?? phoneNormal ?? null,
      visitedDate, visitingDate, nextFollowupAt, demoAttendedAt,
    });
  }
  console.log(`  xlsx rows with at least one date: ${targets.length}\n`);

  // Match each target back to a lead in prod. Phone is the strong key.
  // Name-ILIKE is a tie-breaker only.
  const matched: Matched[] = [];
  const unmatchedNoPhone: Plan[] = [];
  const unmatchedByPhone: Plan[] = [];
  const ambiguous: { plan: Plan; hits: number }[] = [];

  for (const t of targets) {
    if (!t.xlsxPhoneLocal) { unmatchedNoPhone.push(t); continue; }
    const hits = await pool.query<{
      work_item_id: string;
      number: string;
      party_name: string;
      party_phone: string | null;
      visited_date: string | null;
      visiting_date: string | null;
      next_followup_at: string | null;
      demo_attended_at: string | null;
    }>(
      `SELECT
         l.work_item_id,
         wi.number,
         p.name             AS party_name,
         p.phone            AS party_phone,
         l.visited_date::text     AS visited_date,
         l.visiting_date::text    AS visiting_date,
         l.next_followup_at::text AS next_followup_at,
         l.demo_attended_at::text AS demo_attended_at
       FROM lead l
       JOIN work_item wi ON wi.id = l.work_item_id
       JOIN party p ON p.id = wi.party_id
       WHERE wi.tenant_id = $1
         AND wi.type = 'lead'
         AND p.phone = $2`,
      [tenant.id, t.xlsxPhoneLocal],
    );
    if (hits.rowCount === 0) { unmatchedByPhone.push(t); continue; }
    if ((hits.rowCount ?? 0) > 1) { ambiguous.push({ plan: t, hits: hits.rowCount ?? 0 }); continue; }
    const row = hits.rows[0]!;
    matched.push({
      workItemId: row.work_item_id,
      leadNumber: row.number,
      partyName: row.party_name,
      partyPhone: row.party_phone,
      before: {
        visitedDate: row.visited_date,
        visitingDate: row.visiting_date,
        nextFollowupAt: row.next_followup_at,
        demoAttendedAt: row.demo_attended_at,
      },
      after: {
        // Overwrite ALWAYS when xlsx has a value; leave the DB alone when
        // xlsx is empty (nothing to overwrite with).
        visitedDate:    t.visitedDate    ?? row.visited_date,
        visitingDate:   t.visitingDate   ?? row.visiting_date,
        nextFollowupAt: t.nextFollowupAt ?? row.next_followup_at,
        demoAttendedAt: t.demoAttendedAt ?? row.demo_attended_at,
      },
    });
  }

  // Which of the matched rows will ACTUALLY change something? Skip pure
  // no-ops (before === after on every column we manage).
  const changing = matched.filter((m) =>
    m.before.visitedDate    !== m.after.visitedDate
    || m.before.visitingDate   !== m.after.visitingDate
    || m.before.nextFollowupAt !== m.after.nextFollowupAt
    || m.before.demoAttendedAt !== m.after.demoAttendedAt,
  );

  console.log(`=== Match summary ===`);
  console.log(`  matched:                  ${matched.length}`);
  console.log(`    will change something:  ${changing.length}`);
  console.log(`    already correct:        ${matched.length - changing.length}`);
  console.log(`  unmatched (no phone):     ${unmatchedNoPhone.length}`);
  console.log(`  unmatched (phone miss):   ${unmatchedByPhone.length}`);
  console.log(`  ambiguous (multi-match):  ${ambiguous.length}`);

  if (unmatchedByPhone.length > 0) {
    console.log(`\n⚠ Unmatched-by-phone xlsx rows (first 10):`);
    for (const u of unmatchedByPhone.slice(0, 10)) {
      console.log(`    row ${u.rowNo}: "${u.xlsxName}"  phone=${u.xlsxPhoneLocal}`);
    }
    if (unmatchedByPhone.length > 10) console.log(`    …and ${unmatchedByPhone.length - 10} more`);
  }
  if (ambiguous.length > 0) {
    console.log(`\n⚠ Ambiguous (multiple prod leads on same phone):`);
    for (const a of ambiguous) {
      console.log(`    row ${a.plan.rowNo}: "${a.plan.xlsxName}"  phone=${a.plan.xlsxPhoneLocal}  (${a.hits} matches)`);
    }
  }

  if (changing.length > 0) {
    console.log(`\n=== Sample changes (first 5) ===`);
    for (const m of changing.slice(0, 5)) {
      const diffs: string[] = [];
      if (m.before.visitedDate    !== m.after.visitedDate)    diffs.push(`visited: ${m.before.visitedDate ?? "—"} → ${m.after.visitedDate ?? "—"}`);
      if (m.before.visitingDate   !== m.after.visitingDate)   diffs.push(`visiting: ${m.before.visitingDate ?? "—"} → ${m.after.visitingDate ?? "—"}`);
      if (m.before.nextFollowupAt !== m.after.nextFollowupAt) diffs.push(`nextFollowup: ${m.before.nextFollowupAt ?? "—"} → ${m.after.nextFollowupAt ?? "—"}`);
      if (m.before.demoAttendedAt !== m.after.demoAttendedAt) diffs.push(`demo: ${m.before.demoAttendedAt ?? "—"} → ${m.after.demoAttendedAt ?? "—"}`);
      console.log(`  ${m.leadNumber}  ${m.partyName}`);
      for (const d of diffs) console.log(`    ${d}`);
    }
  }

  if (!APPLY) {
    console.log(`\n(dry-run — nothing changed. Re-run with --apply to write.)`);
    await pool.end();
    return;
  }

  if (changing.length === 0) {
    console.log(`\n(nothing to change.)`);
    await pool.end();
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────
  console.log(`\n→ updating ${changing.length} leads (single transaction)…`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant.id]);

    let touched = 0;
    for (const m of changing) {
      await client.query(
        `UPDATE lead
            SET visited_date     = $1::date,
                visiting_date    = $2::date,
                next_followup_at = $3::date,
                demo_attended_at = $4::date
          WHERE work_item_id = $5`,
        [
          m.after.visitedDate,
          m.after.visitingDate,
          m.after.nextFollowupAt,
          m.after.demoAttendedAt,
          m.workItemId,
        ],
      );
      touched += 1;
      if (touched % 25 === 0) console.log(`  ${touched}/${changing.length}…`);
    }

    await client.query("COMMIT");
    console.log(`\n✓ backfill complete. ${touched} rows updated.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n✗ backfill FAILED — transaction rolled back, DB unchanged.`);
    console.error(`  reason: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
