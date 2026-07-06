// One-shot import of leads from an xlsx export into the leads module.
//
// Reads the xlsx passed via --file (default: "../Leads july 6.xlsx"), maps
// each row into the CRM's shape (party + work_item + lead + party_role),
// and writes them in one big transaction. Dry-run by default; pass --apply
// to commit.
//
// Phone handling reads two views of the sheet:
//   - a formatted view for dates (so parseDate gets ISO-looking strings), and
//   - a raw view just for the "Mobile" column.
// Why: Excel stores digit-only phone numbers as scientific-notation numbers
// like 9.17064E+11 when formatted, which truncates to 6 significant digits.
// Reading Mobile raw preserves the full integer (917064327407 etc).
//
// Usage:
//   $env:DATABASE_URL='postgres://decrm_admin:...@.../decrm_prod?sslmode=require'
//   npx tsx src/db/import-leads-xlsx.ts --file "C:\\path\\to\\file.xlsx"
//   # then, when the dry-run looks right:
//   npx tsx src/db/import-leads-xlsx.ts --file "..." --apply
//
// Design notes:
// - Skips rows with no name (unrenderable in the CRM).
// - Merges duplicates by phone (case-insensitive normalized digits).
// - Resolves advisor NAME → app_user.party_id. If an advisor name doesn't
//   match any existing app_user, we halt with an error listing the missing
//   names — the operator should create those advisors via the Manage
//   Advisors admin page before re-running (never auto-create silently).
// - Maps xlsx program names to prod program.id via a hand-tuned lookup table.
// - Rating "Super Hot" → "superhot"; "LukeWarm" → "lukewarm"; everything
//   else lowercased and validated against the schema CHECK.

import { readFileSync, writeFileSync } from "node:fs";
import xlsx from "xlsx";
import { pool } from "./client.js";

// ─── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fileArg = args.find((a) => a.startsWith("--file="));
const XLSX_PATH = fileArg ? fileArg.slice("--file=".length) : "../Leads july 6.xlsx";

// ─── Value maps ──────────────────────────────────────────────────────────
// Source in xlsx → CRM source key. Values in the RIGHT column must match
// entries in the /catalog `sources` list (api/src/routes/catalog.ts).
const SOURCE_MAP: Record<string, { key: string; label: string }> = {
  "":               { key: "web",            label: "Web" },
  "web":            { key: "web",            label: "Web" },
  "web form":       { key: "web_form",       label: "Web Form" },
  "chat":           { key: "chat",           label: "Chat" },
  "phone":          { key: "phone",          label: "Phone" },
  "email":          { key: "email",          label: "Email" },
  "demo":           { key: "demo",           label: "Demo" },
  "referral":       { key: "referral",       label: "Referral" },
  "paid search":    { key: "paid",           label: "Paid Search" },
  "organic search": { key: "organic_search", label: "Organic Search" },
};

// Rating in xlsx → schema rating
const RATING_MAP: Record<string, string> = {
  "":           "new lead",
  "attempted":  "attempted",
  "cold":       "cold",
  "lukewarm":   "lukewarm",
  "warm":       "warm",
  "hot":        "hot",
  "super hot":  "superhot",
  "superhot":   "superhot",
};

// Xlsx "Status" column → CRM lead.lead_status key. Case-insensitive.
// Unknown values return null (fall through), and the raw value is still
// preserved in the composed description footer as "Status (imported): X".
const LEAD_STATUS_MAP: Record<string, string> = {
  "new":                        "new",
  "contacted":                  "contacted",
  "interested":                 "interested",
  "interested in demo":         "interested_in_demo",
  "demo attended":              "demo_attended",
  "visiting":                   "visiting",
  "visited":                    "visited",
  "payment link sent":          "payment_link_sent",
  "enrolled":                   "enrolled",
  "lost lead":                  "lost_lead",
  "unqualified":                "unqualified",
  "advance talk with trainer":  "advance_talk_with_trainer",
};

// Training mode in xlsx → delivery_mode. "Offline" (from older exports)
// is normalised to "classroom" — the CRM's schema CHECK allows only
// (online|classroom|hybrid) since post-0060.
const MODE_MAP: Record<string, string | null> = {
  "":          null,
  "offline":   "classroom",
  "classroom": "classroom",
  "online":    "online",
  "hybrid":    "hybrid",
};

// xlsx program name → prod program name (leftmost item wins from multi-value
// cells like "AI & DS;FullStack Ai"). Values here MUST match a program.name
// currently in prod. Unmapped names fall through to null and the raw text
// is preserved on lead.program (denormalised) so an advisor can pick later.
const PROGRAM_NAME_MAP: Record<string, string> = {
  "ai & ds":            "AI Program",
  "data analyst":       "Data Analyst",
  "data engineer":      "Data Engineer",
  "devops & cloud":     "Devops",
  "fullstack  ai":      "Full Stack with AI",   // note double space in source
  "fullstack ai":       "Full Stack with AI",
  "fullstack java":     "Full Stack Java",
  "fullstack python":   "Full Stack Python",
  "salesforce":         "SF-Masters",
  "servicenow":         "SN-Masters",
  "business analyst":   "Business Analyst with AI",
};

// ─── Helpers ─────────────────────────────────────────────────────────────
function norm(s: string | null | undefined): string {
  return (s ?? "").toString().trim().toLowerCase();
}

// Strip Excel-escape apostrophes and squash spaces from a phone value.
function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toString().replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  return cleaned;
}

// Split "+91XXXXXXXXXX" into cc="+91" + local="XXXXXXXXXX".
// A regex-only split is greedy: /^(\+\d{1,3})(\d{7,15})$/ on "+918237966156"
// grabs "+918" as the CC because the middle group is happy with 9 digits.
// We prefer an explicit whitelist of common country codes, longest first,
// so real numbers land on the correct split. Anything that doesn't match
// keeps the full number in `local` and cc=null.
const KNOWN_CCS = [
  "+971", "+974", "+966", // UAE, QA, SA
  "+91", "+92", "+94",     // IN, PK, LK
  "+61", "+65", "+66",     // AU, SG, TH
  "+44", "+33", "+49", "+34", "+39", "+31", "+41", "+46", "+45", // GB/FR/DE/…
  "+1",                    // US/CA
];

function splitCountryCode(phone: string | null): { cc: string | null; local: string | null } {
  if (!phone) return { cc: null, local: null };
  if (phone.startsWith("+")) {
    for (const cc of KNOWN_CCS) {
      if (phone.startsWith(cc) && phone.length > cc.length) {
        return { cc, local: phone.slice(cc.length) };
      }
    }
    // Unknown prefix — best-effort: take the "+", strip everything past 3
    // digits, keep the rest as local. Matches the CRM's UI convention
    // ("+X" or "+XX" or "+XXX").
    const m = /^(\+\d{1,3})(\d{6,15})$/.exec(phone);
    if (m) return { cc: m[1]!, local: m[2]! };
  } else if (/^\d{10}$/.test(phone)) {
    // 10-digit Indian mobile without a "+" prefix — default to +91.
    return { cc: "+91", local: phone };
  }
  return { cc: null, local: phone };
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_GRADS = ["magenta", "violet", "blue", "ochre", "ok", "mute", "vm"];
function pickAvatar(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_GRADS[h % AVATAR_GRADS.length]!;
}

function firstProgramFromCell(raw: string | null | undefined): { first: string | null; rest: string[] } {
  if (!raw) return { first: null, rest: [] };
  const parts = raw.toString().split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { first: null, rest: [] };
  return { first: parts[0]!, rest: parts.slice(1) };
}

function parseDate(v: unknown): string | null {
  if (!v) return null;
  // xlsx dates come as strings like "2026-07-15 18:30:00 UTC" or JS Dates.
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────
interface LeadRow {
  name: string; email: string | null;
  phone: string | null; phoneCountryCode: string | null;
  city: string | null;
  advisorName: string;
  description: string;
  programText: string | null;
  programId: string | null;
  rating: string;
  source: { key: string; label: string };
  deliveryMode: string | null;
  leadStatus: string | null;    // resolved key (e.g. "demo_attended"), or null
  visitedDate: string | null;
  visitingDate: string | null;
  nextFollowupAt: string | null;
  demoAttendedAt: string | null;
  status: string;               // raw xlsx value, preserved for the description footer
  rowNo: number;
}

async function main() {
  console.log(`→ reading ${XLSX_PATH}…`);
  const buf = readFileSync(XLSX_PATH);
  const wb = xlsx.read(buf, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets["Leads.csv"] ?? wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) throw new Error("no readable sheet in xlsx");
  // Two parallel views: the formatted one keeps dates/text human-readable;
  // the raw one preserves numeric precision on phone cells that Excel would
  // otherwise render as scientific notation (9.17064E+11 -> 917064327407).
  const rows = xlsx.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
  }) as Record<string, unknown>[];
  const rowsRaw = xlsx.utils.sheet_to_json(sheet, {
    defval: null,
    raw: true,
  }) as Record<string, unknown>[];
  console.log(`  ${rows.length} rows in sheet`);

  // Resolve tenant + advisors + programs upfront so per-row work is fast.
  const tenR = await pool.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at DESC LIMIT 1`);
  const tenantId = tenR.rows[0]?.id;
  if (!tenantId) throw new Error("no tenant row found in prod");
  console.log(`  tenant: ${tenantId}`);

  // Advisor lookup by name (ILIKE). "Nishan  " → matches "Nishan"; "Manikanta Kona" → "Manikanta".
  const adv = await pool.query<{ id: string; party_id: string; name: string; email: string }>(
    `SELECT id, party_id, name, email FROM app_user WHERE role IN ('admin','advisor') AND active = true`,
  );
  console.log(`  ${adv.rows.length} active advisors in prod:`);
  for (const a of adv.rows) console.log(`    - ${a.name ?? a.email}`);

  // Hand-tuned aliases for xlsx advisor names that don't match a prod
  // advisor name letter-for-letter.
  const ADVISOR_ALIAS: Record<string, string> = {
    "manikanta kona": "Mani",
  };

  function findAdvisorParty(rawName: string): string | null {
    const n = norm(rawName);
    if (!n) return null;
    // 1. Alias-mapped
    const alias = ADVISOR_ALIAS[n];
    if (alias) {
      for (const a of adv.rows) if (norm(a.name) === norm(alias)) return a.party_id;
    }
    // 2. Exact case-insensitive
    for (const a of adv.rows) if (norm(a.name) === n) return a.party_id;
    // 3. First-word case-insensitive
    for (const a of adv.rows) {
      const first = norm((a.name ?? "").split(/\s+/)[0]);
      if (first && first === n.split(/\s+/)[0]) return a.party_id;
    }
    return null;
  }

  // Program lookup by name.
  const prg = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM program`);
  const programByName = new Map<string, string>();
  for (const p of prg.rows) programByName.set(norm(p.name), p.id);

  function resolveProgramId(rawFirst: string | null): { id: string | null; mappedName: string | null } {
    if (!rawFirst) return { id: null, mappedName: null };
    const mapped = PROGRAM_NAME_MAP[norm(rawFirst)];
    if (!mapped) return { id: null, mappedName: null };
    const id = programByName.get(norm(mapped)) ?? null;
    return { id, mappedName: mapped };
  }

  // Build the plan.
  const plan: LeadRow[] = [];
  const problems: { row: number; issue: string; raw: Record<string, unknown> }[] = [];
  const missingAdvisors = new Set<string>();
  const unmappedPrograms = new Map<string, number>();
  const skippedNoName: number[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const rRaw = rowsRaw[i] ?? {};
    const rowNo = i + 2; // xlsx row number (header is row 1)
    const name = (r["Full name"] ?? "").toString().trim();
    if (!name) { skippedNoName.push(rowNo); continue; }

    // Read Mobile from the RAW view so numeric-shaped phones (Excel's
    // "9.17064E+11") come through as full integers (917064327407). Fall
    // back to the formatted view when raw is empty.
    const phoneRawCell = rRaw["Mobile"] ?? r["Mobile"];
    const phoneRaw = phoneRawCell == null ? "" : String(phoneRawCell);
    const phoneNormal = normalisePhone(phoneRaw);
    const { cc, local } = splitCountryCode(phoneNormal);

    const email = (r["Email"] ?? "").toString().trim() || null;
    const city  = (r["City"]  ?? "").toString().trim() || null;
    // xlsx column name changed across exports — accept both.
    const advisorName = (
      (r["Advisor"] ?? r["Sales owner"] ?? "") as string
    ).toString().trim();
    const description = (r["Description"] ?? "").toString().trim();
    const recentNote  = (r["Recent note"]  ?? "").toString().trim();

    const advisorPartyId = findAdvisorParty(advisorName);
    if (advisorName && !advisorPartyId) missingAdvisors.add(advisorName);

    const { first: firstProgram, rest: otherPrograms } = firstProgramFromCell(r["Eidfy Program"] as string | null);
    const { id: programId, mappedName } = resolveProgramId(firstProgram);
    if (firstProgram && !mappedName) {
      unmappedPrograms.set(firstProgram, (unmappedPrograms.get(firstProgram) ?? 0) + 1);
    }

    // Course column is a ;A;B;C; list; keep the flat comma-joined form for
    // the description note. No CRM field for it today — folded into notes.
    const courseText = ((r["Course"] ?? "") as string).toString()
      .split(";").map((s) => s.trim()).filter(Boolean).join(", ");

    const ratingRaw = norm(r["Lead Rating"] as string | null);
    const rating = RATING_MAP[ratingRaw] ?? "new lead";

    const sourceRaw = norm(r["Source"] as string | null);
    const source = SOURCE_MAP[sourceRaw] ?? { key: "web", label: "Unknown source" };

    const modeRaw = norm(r["Training Mode"] as string | null);
    const deliveryMode = MODE_MAP[modeRaw] ?? null;

    const status = (r["Status"] ?? "").toString().trim();
    // Normalize xlsx Status to CRM lead_status key. Unknown → null; the raw
    // value still lands in the description footer as before.
    const leadStatus = status ? (LEAD_STATUS_MAP[norm(status)] ?? null) : null;

    // Compose description: original notes first, then a footer block that
    // preserves every field that has no direct CRM home (recent note,
    // status, courses, alt programs). Kept as human-readable lines so
    // advisors can scan the record page and see the imported context.
    const footer: string[] = [];
    if (recentNote)             footer.push(`Recent note: ${recentNote}`);
    if (status)                 footer.push(`Status (imported): ${status}`);
    if (courseText)             footer.push(`Course(s): ${courseText}`);
    if (otherPrograms.length)   footer.push(`Also interested in: ${otherPrograms.join(", ")}`);
    if (firstProgram && !mappedName) footer.push(`Original program: ${firstProgram}`);
    const composedDescription = [
      description,
      footer.length ? `— Imported context —\n${footer.join("\n")}` : "",
    ].filter(Boolean).join("\n\n").trim();

    // Store the LOCAL part in party.phone (the CRM concatenates cc+phone at
    // display time — see party.phone_country_code). If we couldn't split a
    // known cc off, leave the full normalised value in `phone` and cc=null.
    plan.push({
      name,
      email,
      phone: local ?? phoneNormal ?? null,
      phoneCountryCode: cc,
      city,
      advisorName,
      description: composedDescription,
      programText: mappedName ?? firstProgram,
      programId,
      rating,
      source,
      deliveryMode,
      leadStatus,
      // Accept both "Visiting Date" (older exports) and "Exp Visiting Date"
      // (Jul 6 export) so the same script handles both shapes.
      visitedDate:    parseDate(r["Visited Date"]),
      visitingDate:   parseDate(r["Visiting Date"] ?? r["Exp Visiting Date"]),
      nextFollowupAt: parseDate(r["Next FollowUp Date"]),
      demoAttendedAt: parseDate(r["Demo Attended Date"]),
      status,
      rowNo,
    });
  }

  // Dedupe by phone. Prefer the later row (they're presumably fresher).
  const byPhone = new Map<string, LeadRow>();
  const dedupedSkipped: number[] = [];
  for (const p of plan) {
    const key = p.phone ?? `nophone:${p.name.toLowerCase()}:${p.email ?? ""}`;
    if (byPhone.has(key)) dedupedSkipped.push(byPhone.get(key)!.rowNo);
    byPhone.set(key, p);
  }
  const finalPlan = [...byPhone.values()];

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n=== Import plan ===`);
  console.log(`  input rows:            ${rows.length}`);
  console.log(`  skipped (no name):     ${skippedNoName.length}`);
  console.log(`  duplicates deduped:    ${dedupedSkipped.length}`);
  console.log(`  final rows to insert:  ${finalPlan.length}`);
  console.log(`  programs mapped:       ${finalPlan.filter((p) => p.programId).length}`);
  console.log(`  programs unmapped:     ${finalPlan.filter((p) => !p.programId && p.programText).length}`);
  console.log(`  advisors resolved:     ${finalPlan.filter((p) => findAdvisorParty(p.advisorName)).length}`);
  console.log(`  advisors missing:      ${finalPlan.filter((p) => p.advisorName && !findAdvisorParty(p.advisorName)).length}`);
  console.log(`  lead status resolved:  ${finalPlan.filter((p) => p.leadStatus).length}`);
  console.log(`  lead status unmapped:  ${finalPlan.filter((p) => !p.leadStatus && p.status).length}`);

  if (missingAdvisors.size > 0) {
    console.log(`\n⚠ Missing advisors — add them in Settings → Advisors before applying:`);
    for (const n of missingAdvisors) console.log(`    - "${n}"`);
  }
  if (unmappedPrograms.size > 0) {
    console.log(`\n⚠ Unmapped program names — will be stored as free-text (no programId):`);
    for (const [n, c] of unmappedPrograms) console.log(`    - "${n}" (${c} rows)`);
  }

  // Preview 3 rows
  console.log(`\n=== Sample (first 3) ===`);
  for (const p of finalPlan.slice(0, 3)) {
    console.log(JSON.stringify({
      row: p.rowNo, name: p.name, phone: p.phone, email: p.email,
      advisor: p.advisorName, program: p.programText, programId: p.programId,
      rating: p.rating, source: p.source.key, status: p.status,
    }));
  }

  // Dump the full plan to a JSON file so the operator can eyeball it.
  const planFile = `import-plan-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  writeFileSync(planFile, JSON.stringify(finalPlan, null, 2), "utf8");
  console.log(`\nFull plan written to ${planFile}`);

  if (missingAdvisors.size > 0) {
    console.log(`\n✗ Halting: create the missing advisors first, then re-run.`);
    await pool.end();
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\n(dry-run — nothing changed. Re-run with --apply to write to prod.)`);
    await pool.end();
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────
  console.log(`\n→ APPLYING to prod (${finalPlan.length} rows)…`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

    // Sentinel party — used as actor_party_id for the "Lead imported" activity row.
    const sentinelR = await client.query<{ id: string }>(
      `SELECT id FROM party WHERE tenant_id = $1 AND is_system = true LIMIT 1`,
      [tenantId],
    );
    const sentinelPartyId = sentinelR.rows[0]?.id ?? null;

    let inserted = 0;
    for (const p of finalPlan) {
      const advisorPartyId = findAdvisorParty(p.advisorName);

      // 1) party
      const partyR = await client.query<{ id: string }>(
        `INSERT INTO party (tenant_id, kind, name, email, phone, phone_country_code, city, identifiers, attributes)
         VALUES ($1, 'person', $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
         RETURNING id`,
        [
          tenantId, p.name, p.email, p.phone, p.phoneCountryCode, p.city,
          JSON.stringify({ source: p.source.key, imported: "xlsx-2026-07-06" }),
          JSON.stringify({ initials: initialsOf(p.name) }),
        ],
      );
      const partyId = partyR.rows[0]!.id;

      // 2) party_role = lead
      await client.query(
        `INSERT INTO party_role (tenant_id, party_id, role, valid_from)
         VALUES ($1, $2, 'lead', current_date)
         ON CONFLICT (party_id, role, valid_from) DO NOTHING`,
        [tenantId, partyId],
      );

      // 3) work_item
      const numR = await client.query<{ n: string }>(`SELECT nextval('seq_lead')::text AS n`);
      const number = `LEAD-${numR.rows[0]!.n}`;
      const wiR = await client.query<{ id: string }>(
        `INSERT INTO work_item (tenant_id, number, type, party_id, assignee_id, state, priority, attributes)
         VALUES ($1, $2, 'lead', $3, $4, 'open', 3, $5::jsonb)
         RETURNING id`,
        [tenantId, number, partyId, advisorPartyId, JSON.stringify({ source: p.source.key, sourceLabel: p.source.label })],
      );
      const workItemId = wiR.rows[0]!.id;

      // 4) lead
      await client.query(
        `INSERT INTO lead (
           work_item_id, tenant_id, source, source_label, score, rating, stage, stage_label,
           heat, advisor_id, avatar, initials, description,
           program, program_id,
           delivery_mode, lead_status,
           next_followup_at, demo_attended_at, visited_date, visiting_date,
           nba_label, nba_icon
         )
         VALUES (
           $1, $2, $3, $4, 50, $5, 'new', 'New inbound',
           'warm', $6, $7, $8, $9,
           $10, $11,
           $12, $13,
           $14, $15, $16, $17,
           'Reach out today', 'send'
         )`,
        [
          workItemId, tenantId, p.source.key, p.source.label, p.rating,
          advisorPartyId, pickAvatar(p.name), initialsOf(p.name), p.description || null,
          p.programText, p.programId,
          p.deliveryMode, p.leadStatus,
          p.nextFollowupAt, p.demoAttendedAt, p.visitedDate, p.visitingDate,
        ],
      );

      // 5) activity row so timeline shows how the lead came in
      await client.query(
        `INSERT INTO activity (
           tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name,
           verb, detail, tag, payload, ts
         )
         VALUES (
           $1, $2, $3, 'agent', $4, 'System',
           'Lead imported', $5, 'ai', $6::jsonb, NOW()
         )`,
        [
          tenantId, workItemId, partyId, sentinelPartyId,
          `Imported from Today UpdatedLeads.xlsx (row ${p.rowNo})`,
          JSON.stringify({ when: "Just now", quote: null, importedFrom: "xlsx", rowNo: p.rowNo, status: p.status }),
        ],
      );

      inserted += 1;
      if (inserted % 25 === 0) console.log(`  ${inserted}/${finalPlan.length}…`);
    }

    await client.query("COMMIT");
    console.log(`\n✓ imported ${inserted} leads`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n✗ import failed — transaction rolled back:`, (err as Error).message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
