// Verifies the catalogue-registry and module schema end to end: post-0087
// through post-0093.
//
//   npm run db:verify-catalogue
//
// Runs as decrm_app — the SAME role the HTTP handlers use — so it exercises
// the RLS policies and table grants, not just the SQL. That matters: a
// missing GRANT on a new table is invisible when you test as the admin role
// and fatal in production.
//
// Everything happens inside one transaction that is ROLLED BACK at the end,
// so running this against a live database leaves nothing behind. Exits
// non-zero on the first failure count, which makes it usable in CI.
//
// Two kinds of assertion:
//   ok(...)          something that must succeed
//   mustReject(...)  something the schema must REFUSE — the constraint tests.
//                    A silently-accepted bad row is the failure mode these
//                    exist to catch.
import "dotenv/config";
import pg from "pg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const url = process.env.APP_DATABASE_URL;
if (!url) throw new Error("APP_DATABASE_URL is not set — this verifier must connect as decrm_app, not admin.");
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: true } });
const c = await pool.connect();
const T = process.env.DEFAULT_TENANT_ID;
if (!T) throw new Error("DEFAULT_TENANT_ID is not set.");

let pass = 0, fail = 0;
const ok  = (m: string) => { pass++; console.log("  PASS  " + m); };
const bad = (m: string, e?: string) => { fail++; console.log("  FAIL  " + m + (e ? " -> " + e : "")); };

let sp = 0;
// Run a statement that MUST violate a constraint. Savepoint so the outer
// transaction survives the expected error.
async function mustReject(label: string, sqlText: string, params?: unknown[]) {
  const name = "sp" + (++sp);
  await c.query("SAVEPOINT " + name);
  try {
    await c.query(sqlText, params);
    await c.query("ROLLBACK TO " + name);
    bad(label + " — was ACCEPTED but should have been rejected");
  } catch (e) {
    await c.query("ROLLBACK TO " + name);
    const first = String((e as Error).message).split("\n")[0] ?? "";
    ok(label + " — rejected: " + first.slice(0, 80));
  }
}

await c.query("BEGIN");
await c.query("SET LOCAL app.tenant_id = '" + T + "'");

try {
  // ── account ──────────────────────────────────────────────────────────
  const org = (await c.query(
    "INSERT INTO party (tenant_id,kind,name) VALUES (current_tenant(),'org','Acme Corp') RETURNING id")).rows[0].id;
  const acc = (await c.query(
    "INSERT INTO account (tenant_id,party_id,account_type,industry,status) VALUES (current_tenant(),$1,'hiring_partner','Technology','active') RETURNING account_number",
    [org])).rows[0];
  ok("account created: " + acc.account_number);

  const person = (await c.query(
    "INSERT INTO party (tenant_id,kind,name) VALUES (current_tenant(),'person','Priya Nair') RETURNING id")).rows[0].id;

  await mustReject("account on a person party",
    "INSERT INTO account (tenant_id,party_id) VALUES (current_tenant(),$1)", [person]);

  // ── contact + affiliation ────────────────────────────────────────────
  await c.query("INSERT INTO contact (tenant_id,party_id,job_title,contact_role) VALUES (current_tenant(),$1,'VP Engineering','decision_maker')", [person]);
  await c.query("INSERT INTO party_affiliation (tenant_id,person_party_id,org_party_id,role_at_org,is_primary,valid_from) VALUES (current_tenant(),$1,$2,'decision_maker',true,CURRENT_DATE)", [person, org]);
  ok("contact + primary affiliation created");

  await mustReject("second current primary employer for one person",
    "INSERT INTO party_affiliation (tenant_id,person_party_id,org_party_id,is_primary,valid_from) VALUES (current_tenant(),$1,$2,true,CURRENT_DATE)", [person, org]);

  // ── opportunity ──────────────────────────────────────────────────────
  const wi = (await c.query(
    "INSERT INTO work_item (tenant_id,number,type,party_id,state) VALUES (current_tenant(),'DEAL-'||nextval('seq_deal'),'deal',$1,'open') RETURNING id,number",
    [org])).rows[0];
  await c.query(
    "INSERT INTO deal (tenant_id,work_item_id,name,account_party_id,primary_contact_party_id,stage,value,expected_close_date) VALUES (current_tenant(),$1,'Acme — Agentic AI cohort',$2,$3,'proposal',2500000,'2026-11-30')",
    [wi.id, org, person]);
  ok("opportunity created: " + wi.number);

  await mustReject("closing a deal with no actual_close_date",
    "UPDATE deal SET stage='closed_won' WHERE work_item_id=$1", [wi.id]);

  // now() is the TRANSACTION timestamp, so a freshly-inserted row and an
  // update inside the same transaction share it. Back-date the column first,
  // then check the trigger drags it forward.
  await c.query("UPDATE deal SET stage_updated_at = now() - interval '30 days' WHERE work_item_id=$1", [wi.id]);
  const before = (await c.query("SELECT stage_updated_at FROM deal WHERE work_item_id=$1", [wi.id])).rows[0].stage_updated_at;

  await c.query("UPDATE deal SET stage='closed_won', actual_close_date=CURRENT_DATE WHERE work_item_id=$1", [wi.id]);
  const after = (await c.query("SELECT stage_updated_at FROM deal WHERE work_item_id=$1", [wi.id])).rows[0].stage_updated_at;
  if (after > before) ok("stage_updated_at dragged forward by the trigger on a stage move");
  else bad("stage trigger did not fire");

  // …and must NOT move when something else on the row changes.
  await c.query("UPDATE deal SET stage_updated_at = now() - interval '30 days' WHERE work_item_id=$1", [wi.id]);
  const held = (await c.query("SELECT stage_updated_at FROM deal WHERE work_item_id=$1", [wi.id])).rows[0].stage_updated_at;
  await c.query("UPDATE deal SET next_action='Send revised SOW' WHERE work_item_id=$1", [wi.id]);
  const stillHeld = (await c.query("SELECT stage_updated_at FROM deal WHERE work_item_id=$1", [wi.id])).rows[0].stage_updated_at;
  if (String(stillHeld) === String(held)) ok("stage_updated_at left alone when the stage does not change");
  else bad("stage trigger fired on a non-stage edit");

  // ── requisition ──────────────────────────────────────────────────────
  const r = (await c.query(
    "INSERT INTO requisition (tenant_id,account_party_id,job_title,openings,status,required_skills,minimum_experience_months) VALUES (current_tenant(),$1,'Agentic AI Engineer',2,'open',ARRAY['Python','LangGraph'],0) RETURNING id,number",
    [org])).rows[0];
  ok("requisition created: " + r.number);

  await mustReject("approving a requisition with no approver",
    "UPDATE requisition SET approval_status='approved' WHERE id=$1", [r.id]);
  await mustReject("requisition with zero openings",
    "UPDATE requisition SET openings=0 WHERE id=$1", [r.id]);

  // ── candidate + the eligibility gate ─────────────────────────────────
  const learnerRow: Row = (await c.query("SELECT party_id FROM learner_profile LIMIT 1")).rows[0];
  if (!learnerRow) {
    console.log("  SKIP  candidate/application tests — no learner_profile row in dev");
  } else {
    const L = learnerRow.party_id;
    const cand = (await c.query(
      "INSERT INTO candidate (tenant_id,party_id,skills,profile_status,total_experience_months) VALUES (current_tenant(),$1,ARRAY['Python'],'ready',12) RETURNING number",
      [L])).rows[0];
    ok("candidate created: " + cand.number);

    let n = (await c.query("SELECT 1 FROM candidate_eligible WHERE party_id=$1", [L])).rowCount;
    if (n === 0) ok("gate holds — not eligible while unqualified / no consent");
    else bad("gate leaked — eligible before qualification");

    await c.query("UPDATE learner_profile SET staffing_eligibility_status='qualified', staffing_consent_status='granted' WHERE party_id=$1", [L]);
    n = (await c.query("SELECT 1 FROM candidate_eligible WHERE party_id=$1", [L])).rowCount;
    if (n === 1) ok("gate opens once qualified AND consented");
    else bad("gate did not open after qualification + consent");

    // ── application ────────────────────────────────────────────────────
    const a = (await c.query(
      "INSERT INTO application (tenant_id,candidate_party_id,requisition_id) VALUES (current_tenant(),$1,$2) RETURNING id,number",
      [L, r.id])).rows[0];
    ok("application created: " + a.number);

    await mustReject("duplicate application to the same requisition",
      "INSERT INTO application (tenant_id,candidate_party_id,requisition_id) VALUES (current_tenant(),$1,$2)", [L, r.id]);
    await mustReject("rejecting an application with no reason",
      "UPDATE application SET stage='rejected' WHERE id=$1", [a.id]);
    await mustReject("screening score out of range",
      "UPDATE application SET screening_score=140 WHERE id=$1", [a.id]);

    await c.query("UPDATE application SET stage='shortlisted' WHERE id=$1", [a.id]);
    ok("application advanced to shortlisted");

    await c.query("UPDATE application SET stage='rejected', rejection_reason='Needs more production experience' WHERE id=$1", [a.id]);
    ok("rejection accepted when a reason is given");

    // The whole point of putting the gate on learner_profile.
    await c.query("UPDATE learner_profile SET staffing_consent_status='withdrawn' WHERE party_id=$1", [L]);
    n = (await c.query("SELECT 1 FROM candidate_eligible WHERE party_id=$1", [L])).rowCount;
    if (n === 0) ok("withdrawing consent removes them from the gate immediately");
    else bad("consent withdrawal did not close the gate");
  }

  // ── worker ───────────────────────────────────────────────────────────
  const w = (await c.query(
    "INSERT INTO worker (tenant_id,party_id,worker_type,designation,department,trainer_capable,skills) VALUES (current_tenant(),$1,'trainer','Senior Trainer','Delivery',true,ARRAY['Python','GenAI']) RETURNING employee_number",
    [person])).rows[0];
  ok("worker created: " + w.employee_number);

  await mustReject("worker reporting to themselves",
    "UPDATE worker SET reporting_to_party_id=party_id WHERE party_id=$1", [person]);
  await mustReject("exit date before joining date",
    "UPDATE worker SET date_of_joining='2026-05-01', date_of_exit='2026-01-01' WHERE party_id=$1", [person]);

  // ── post-0088 columns accept their vocabularies ──────────────────────
  await mustReject("lead.working_status outside its vocabulary",
    "UPDATE lead SET working_status='employed' WHERE work_item_id IN (SELECT work_item_id FROM lead LIMIT 1)");
  await mustReject("enrolment.identity_proof_status outside its vocabulary",
    "UPDATE enrolment SET identity_proof_status='maybe' WHERE id IN (SELECT id FROM enrolment LIMIT 1)");
  await mustReject("learner_profile.progress_percent above 100",
    "UPDATE learner_profile SET progress_percent=140 WHERE party_id IN (SELECT party_id FROM learner_profile LIMIT 1)");

  // ── post-0093: one delivery-mode vocabulary everywhere ────────────────
  //
  // post-0088 briefly gave enrolment and cohort the 'offline' spelling that
  // post-0060 had already retired from `lead`, leaving the CRM holding two
  // words for one concept. These four assertions are what stops that coming
  // back: the retired spelling must be refused on every table that carries
  // the column, and the live one accepted.
  for (const tbl of ["enrolment", "cohort"]) {
    const idCol = tbl === "enrolment" ? "id" : "id";
    await mustReject(tbl + ".delivery_mode rejects the retired 'offline' spelling",
      `UPDATE ${tbl} SET delivery_mode='offline' WHERE ${idCol} IN (SELECT ${idCol} FROM ${tbl} LIMIT 1)`);

    const n = (await c.query(`SELECT ${idCol} FROM ${tbl} LIMIT 1`)).rowCount;
    if (n === 0) {
      console.log("  SKIP  " + tbl + ".delivery_mode accepts 'classroom' — no rows in dev");
    } else {
      await c.query(`UPDATE ${tbl} SET delivery_mode='classroom' WHERE ${idCol} IN (SELECT ${idCol} FROM ${tbl} LIMIT 1)`);
      ok(tbl + ".delivery_mode accepts 'classroom'");
    }
  }

  // lead has used 'classroom' since post-0060 and must still agree.
  await mustReject("lead.delivery_mode rejects the retired 'offline' spelling",
    "UPDATE lead SET delivery_mode='offline' WHERE work_item_id IN (SELECT work_item_id FROM lead LIMIT 1)");
} catch (e) {
  bad("unexpected error", (e as Error).message);
}

console.log("\n" + pass + " passed, " + fail + " failed");
await c.query("ROLLBACK");   // leaves nothing behind
c.release();
await pool.end();
process.exit(fail ? 1 : 0);
