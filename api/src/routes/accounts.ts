// B2B accounts and contacts — /accounts, /contacts.
//
// Both are party satellites. The router therefore creates a `party` (kind
// 'org' for an account, 'person' for a contact) and hangs the satellite off
// it, rather than inventing a second identity store. The employer link is a
// `party_affiliation` row, which already carries is_primary and the valid
// interval — so "worked at Acme until March, now at Beta" is representable
// without any column here changing.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const accountsRouter = Router();
export const contactsRouter = Router();

const UUID = /^[0-9a-fA-F-]{36}$/;

const ACCOUNT_TYPES  = ["client", "prospect", "partner", "vendor", "hiring_partner"] as const;
const ACCOUNT_STATUS = ["active", "inactive", "churned"] as const;
const RATINGS        = ["hot", "warm", "cold"] as const;
const CONTACT_ROLES  = ["decision_maker", "evaluator", "sponsor", "influencer", "user", "gatekeeper"] as const;
const CONTACT_METHODS = ["email", "phone", "whatsapp", "sms", "none"] as const;

function pickEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | null {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!(allowed as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`${field} must be one of: ${allowed.join(", ")}`), { code: "BAD_ENUM" });
  }
  return s as T[number];
}

const ACCOUNT_SELECT = sql`
  SELECT
    a.party_id       AS "partyId",
    a.account_number AS "accountNumber",
    p.name,
    p.email,
    p.phone,
    p.city,
    a.account_type   AS "accountType",
    a.industry,
    a.ownership,
    a.website,
    a.annual_revenue AS "annualRevenue",
    a.currency,
    a.owner_party_id AS "ownerPartyId",
    own.name         AS "ownerName",
    a.rating,
    a.status,
    a.description,
    a.created_at     AS "createdAt",
    a.updated_at     AS "updatedAt",
    -- Currently-affiliated people only. An ex-employee should not inflate the
    -- contact count on an account they left.
    (SELECT COUNT(*)::int FROM party_affiliation af
      WHERE af.org_party_id = a.party_id AND af.valid_to IS NULL)               AS "contactCount",
    (SELECT COUNT(*)::int FROM deal d
      WHERE d.account_party_id = a.party_id
        AND d.stage NOT IN ('closed_won','closed_lost'))                        AS "openOpportunityCount",
    COALESCE((SELECT SUM(d.value) FROM deal d
      WHERE d.account_party_id = a.party_id
        AND d.stage NOT IN ('closed_won','closed_lost')), 0)                    AS "openPipelineValue",
    (SELECT COUNT(*)::int FROM requisition r
      WHERE r.account_party_id = a.party_id AND r.status = 'open')              AS "openRequisitionCount"
  FROM account a
  JOIN party p ON p.id = a.party_id
  LEFT JOIN party own ON own.id = a.owner_party_id
`;

const CONTACT_SELECT = sql`
  SELECT
    c.party_id  AS "partyId",
    p.name,
    p.email,
    p.phone,
    p.city,
    c.job_title  AS "jobTitle",
    c.department,
    c.contact_role AS "contactRole",
    c.preferred_contact_method AS "preferredContactMethod",
    c.preferred_language       AS "preferredLanguage",
    c.state,
    c.country,
    c.description,
    c.created_at AS "createdAt",
    c.updated_at AS "updatedAt",
    -- The current employer, from the affiliation. NULL for an unaffiliated
    -- contact, which is legitimate: people exist between jobs.
    af.org_party_id AS "accountPartyId",
    org.name        AS "accountName",
    af.role_at_org  AS "roleAtOrg",
    af.valid_from   AS "affiliationValidFrom"
  FROM contact c
  JOIN party p ON p.id = c.party_id
  LEFT JOIN party_affiliation af
    ON af.person_party_id = c.party_id AND af.valid_to IS NULL AND af.is_primary = true
  LEFT JOIN party org ON org.id = af.org_party_id
`;

// ─── Accounts ─────────────────────────────────────────────────────────────

accountsRouter.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const type = String(req.query.type ?? "").trim();
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${ACCOUNT_SELECT}
        WHERE ${q ? sql`(p.name ILIKE ${"%" + q + "%"} OR a.account_number ILIKE ${"%" + q + "%"} OR a.industry ILIKE ${"%" + q + "%"})` : sql`true`}
          AND ${type ? sql`a.account_type = ${type}` : sql`true`}
        ORDER BY (a.status = 'active') DESC, p.name
      `);
      return r.rows;
    });
    res.json({ accounts: rows });
  } catch (err) { next(err); }
});

accountsRouter.get("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });

    const found = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`${ACCOUNT_SELECT} WHERE a.party_id = ${partyId}`);
      if (!r.rows[0]) return null;
      const contacts = await db.execute(sql`
        ${CONTACT_SELECT} WHERE af.org_party_id = ${partyId}
        ORDER BY p.name
      `);
      const opps = await db.execute(sql`
        SELECT d.work_item_id AS "workItemId", wi.number, d.name, d.stage, d.value,
               d.currency, d.expected_close_date AS "expectedCloseDate", d.probability
          FROM deal d JOIN work_item wi ON wi.id = d.work_item_id
         WHERE d.account_party_id = ${partyId}
         ORDER BY d.stage, d.expected_close_date NULLS LAST
      `);
      const reqs = await db.execute(sql`
        SELECT r.id, r.number, r.job_title AS "jobTitle", r.openings, r.status,
               r.target_close_date AS "targetCloseDate",
               (SELECT COUNT(*)::int FROM application ap WHERE ap.requisition_id = r.id) AS "applicationCount"
          FROM requisition r WHERE r.account_party_id = ${partyId}
         ORDER BY r.created_at DESC
      `);
      return {
        ...(r.rows[0] as object),
        contacts: contacts.rows,
        opportunities: opps.rows,
        requisitions: reqs.rows,
      };
    });

    if (!found) return res.status(404).json({ error: "account not found" });
    res.json({ account: found });
  } catch (err) { next(err); }
});

accountsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });

    let accountType, status, rating;
    try {
      accountType = pickEnum(b.accountType, ACCOUNT_TYPES,  "accountType")  ?? "prospect";
      status      = pickEnum(b.status,      ACCOUNT_STATUS, "status")       ?? "active";
      rating      = pickEnum(b.rating,      RATINGS,        "rating");
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const created = await withTenant(req.tenantId!, async (db) => {
      const dup = await db.execute(sql`
        SELECT a.party_id FROM account a JOIN party p ON p.id = a.party_id
         WHERE LOWER(p.name) = LOWER(${name}) LIMIT 1
      `);
      if (dup.rows[0]) throw Object.assign(new Error("duplicate"), { code: "DUP" });

      const ins = await db.execute(sql`
        INSERT INTO party (tenant_id, kind, name, email, phone, city)
        VALUES (current_tenant(), 'org', ${name},
                ${b.email ? String(b.email).trim() : null},
                ${b.phone ? String(b.phone).trim() : null},
                ${b.city  ? String(b.city).trim()  : null})
        RETURNING id
      `);
      const partyId = (ins.rows[0] as { id: string }).id;

      await db.execute(sql`
        INSERT INTO account (
          tenant_id, party_id, account_type, industry, ownership, website,
          annual_revenue, currency, owner_party_id, rating, status, description
        ) VALUES (
          current_tenant(), ${partyId}, ${accountType},
          ${b.industry  ? String(b.industry).trim()  : null},
          ${b.ownership ? String(b.ownership).trim() : null},
          ${b.website   ? String(b.website).trim()   : null},
          ${b.annualRevenue != null && b.annualRevenue !== "" ? String(b.annualRevenue) : null},
          ${b.currency ? String(b.currency).trim() : "INR"},
          ${b.ownerPartyId && UUID.test(String(b.ownerPartyId)) ? String(b.ownerPartyId) : null},
          ${rating}, ${status},
          ${b.description ? String(b.description).trim() : null}
        )
      `);

      const r = await db.execute(sql`${ACCOUNT_SELECT} WHERE a.party_id = ${partyId}`);
      return r.rows[0];
    });

    res.status(201).json({ account: created });
  } catch (err) {
    if ((err as { code?: string }).code === "DUP") {
      return res.status(409).json({ error: "An account with that name already exists" });
    }
    next(err);
  }
});

accountsRouter.patch("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    try {
      if (b.accountType !== undefined) sets.push(sql`account_type = ${pickEnum(b.accountType, ACCOUNT_TYPES, "accountType")}`);
      if (b.status      !== undefined) sets.push(sql`status       = ${pickEnum(b.status, ACCOUNT_STATUS, "status")}`);
      if (b.rating      !== undefined) sets.push(sql`rating       = ${pickEnum(b.rating, RATINGS, "rating")}`);
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    if (b.industry    !== undefined) sets.push(sql`industry    = ${b.industry    ? String(b.industry).trim()    : null}`);
    if (b.ownership   !== undefined) sets.push(sql`ownership   = ${b.ownership   ? String(b.ownership).trim()   : null}`);
    if (b.website     !== undefined) sets.push(sql`website     = ${b.website     ? String(b.website).trim()     : null}`);
    if (b.description !== undefined) sets.push(sql`description = ${b.description ? String(b.description).trim() : null}`);
    if (b.currency    !== undefined) sets.push(sql`currency    = ${b.currency ? String(b.currency).trim() : "INR"}`);
    if (b.annualRevenue !== undefined) {
      sets.push(sql`annual_revenue = ${b.annualRevenue != null && b.annualRevenue !== "" ? String(b.annualRevenue) : null}`);
    }
    if (b.ownerPartyId !== undefined) {
      const owner = b.ownerPartyId ? String(b.ownerPartyId).trim() : null;
      if (owner && !UUID.test(owner)) return res.status(400).json({ error: "invalid ownerPartyId" });
      sets.push(sql`owner_party_id = ${owner}`);
    }

    const nameChange = b.name !== undefined ? String(b.name).trim() : null;
    if (b.name !== undefined && !nameChange) return res.status(400).json({ error: "name cannot be empty" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      // The organisation's NAME lives on party, not account.
      if (nameChange) {
        await db.execute(sql`UPDATE party SET name = ${nameChange} WHERE id = ${partyId} AND kind = 'org'`);
      }
      if (sets.length > 0) {
        const r = await db.execute(sql`
          UPDATE account SET ${sql.join(sets, sql`, `)} WHERE party_id = ${partyId} RETURNING party_id
        `);
        if (!r.rows[0]) return null;
      }
      const detail = await db.execute(sql`${ACCOUNT_SELECT} WHERE a.party_id = ${partyId}`);
      return detail.rows[0] ?? null;
    });

    if (!updated) return res.status(404).json({ error: "account not found" });
    res.json({ account: updated });
  } catch (err) { next(err); }
});

// ─── Contacts ─────────────────────────────────────────────────────────────

contactsRouter.get("/", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    const accountId = String(req.query.accountId ?? "").trim();
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        ${CONTACT_SELECT}
        WHERE ${q ? sql`(p.name ILIKE ${"%" + q + "%"} OR p.email ILIKE ${"%" + q + "%"} OR c.job_title ILIKE ${"%" + q + "%"})` : sql`true`}
          AND ${accountId && UUID.test(accountId) ? sql`af.org_party_id = ${accountId}` : sql`true`}
        ORDER BY p.name
      `);
      return r.rows;
    });
    res.json({ contacts: rows });
  } catch (err) { next(err); }
});

contactsRouter.post("/", async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });

    const accountPartyId = b.accountPartyId ? String(b.accountPartyId).trim() : null;
    if (accountPartyId && !UUID.test(accountPartyId)) {
      return res.status(400).json({ error: "invalid accountPartyId" });
    }

    let contactRole, preferredMethod;
    try {
      contactRole     = pickEnum(b.contactRole, CONTACT_ROLES, "contactRole");
      preferredMethod = pickEnum(b.preferredContactMethod, CONTACT_METHODS, "preferredContactMethod");
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    const created = await withTenant(req.tenantId!, async (db) => {
      if (accountPartyId) {
        const acc = await db.execute(sql`SELECT party_id FROM account WHERE party_id = ${accountPartyId}`);
        if (!acc.rows[0]) throw Object.assign(new Error("no account"), { code: "NO_ACCOUNT" });
      }

      const ins = await db.execute(sql`
        INSERT INTO party (tenant_id, kind, name, email, phone, city)
        VALUES (current_tenant(), 'person', ${name},
                ${b.email ? String(b.email).trim() : null},
                ${b.phone ? String(b.phone).trim() : null},
                ${b.city  ? String(b.city).trim()  : null})
        RETURNING id
      `);
      const partyId = (ins.rows[0] as { id: string }).id;

      await db.execute(sql`
        INSERT INTO contact (
          tenant_id, party_id, job_title, department, contact_role,
          preferred_contact_method, preferred_language, state, country, description
        ) VALUES (
          current_tenant(), ${partyId},
          ${b.jobTitle   ? String(b.jobTitle).trim()   : null},
          ${b.department ? String(b.department).trim() : null},
          ${contactRole}, ${preferredMethod},
          ${b.preferredLanguage ? String(b.preferredLanguage).trim() : null},
          ${b.state   ? String(b.state).trim()   : null},
          ${b.country ? String(b.country).trim() : "India"},
          ${b.description ? String(b.description).trim() : null}
        )
      `);

      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${partyId}, 'contact', CURRENT_DATE)
        ON CONFLICT DO NOTHING
      `);

      // The employer link. is_primary = true is guarded by a partial unique
      // index on (tenant, person) where valid_to IS NULL, so a person can only
      // have one current primary employer.
      if (accountPartyId) {
        await db.execute(sql`
          INSERT INTO party_affiliation (tenant_id, person_party_id, org_party_id, role_at_org, is_primary, valid_from)
          VALUES (current_tenant(), ${partyId}, ${accountPartyId}, ${contactRole}, true, CURRENT_DATE)
        `);
      }

      const r = await db.execute(sql`${CONTACT_SELECT} WHERE c.party_id = ${partyId}`);
      return r.rows[0];
    });

    res.status(201).json({ contact: created });
  } catch (err) {
    if ((err as { code?: string }).code === "NO_ACCOUNT") {
      return res.status(400).json({ error: "account not found" });
    }
    next(err);
  }
});

contactsRouter.patch("/:partyId", async (req, res, next) => {
  try {
    const partyId = String(req.params.partyId);
    if (!UUID.test(partyId)) return res.status(400).json({ error: "invalid partyId" });
    const b = req.body ?? {};

    const sets: ReturnType<typeof sql>[] = [];
    try {
      if (b.contactRole !== undefined) sets.push(sql`contact_role = ${pickEnum(b.contactRole, CONTACT_ROLES, "contactRole")}`);
      if (b.preferredContactMethod !== undefined) {
        sets.push(sql`preferred_contact_method = ${pickEnum(b.preferredContactMethod, CONTACT_METHODS, "preferredContactMethod")}`);
      }
    } catch (err) { return res.status(400).json({ error: (err as Error).message }); }

    if (b.jobTitle          !== undefined) sets.push(sql`job_title = ${b.jobTitle ? String(b.jobTitle).trim() : null}`);
    if (b.department        !== undefined) sets.push(sql`department = ${b.department ? String(b.department).trim() : null}`);
    if (b.preferredLanguage !== undefined) sets.push(sql`preferred_language = ${b.preferredLanguage ? String(b.preferredLanguage).trim() : null}`);
    if (b.state             !== undefined) sets.push(sql`state = ${b.state ? String(b.state).trim() : null}`);
    if (b.country           !== undefined) sets.push(sql`country = ${b.country ? String(b.country).trim() : "India"}`);
    if (b.description       !== undefined) sets.push(sql`description = ${b.description ? String(b.description).trim() : null}`);

    const nameChange = b.name !== undefined ? String(b.name).trim() : null;
    if (b.name !== undefined && !nameChange) return res.status(400).json({ error: "name cannot be empty" });

    const updated = await withTenant(req.tenantId!, async (db) => {
      if (nameChange) {
        await db.execute(sql`UPDATE party SET name = ${nameChange} WHERE id = ${partyId} AND kind = 'person'`);
      }
      if (sets.length > 0) {
        const r = await db.execute(sql`
          UPDATE contact SET ${sql.join(sets, sql`, `)} WHERE party_id = ${partyId} RETURNING party_id
        `);
        if (!r.rows[0]) return null;
      }

      // Moving employer end-dates the old affiliation rather than editing it,
      // so the history survives. Passing null just ends the current one.
      if (b.accountPartyId !== undefined) {
        const next = b.accountPartyId ? String(b.accountPartyId).trim() : null;
        if (next && !UUID.test(next)) throw Object.assign(new Error("bad account"), { code: "BAD_ACCOUNT" });

        const current = await db.execute(sql`
          SELECT id, org_party_id FROM party_affiliation
           WHERE person_party_id = ${partyId} AND valid_to IS NULL AND is_primary = true
        `);
        const cur = current.rows[0] as { id: string; org_party_id: string } | undefined;

        if (cur?.org_party_id !== next) {
          if (cur) {
            await db.execute(sql`
              UPDATE party_affiliation SET valid_to = CURRENT_DATE, is_primary = false WHERE id = ${cur.id}
            `);
          }
          if (next) {
            await db.execute(sql`
              INSERT INTO party_affiliation (tenant_id, person_party_id, org_party_id, role_at_org, is_primary, valid_from)
              VALUES (current_tenant(), ${partyId}, ${next},
                      (SELECT contact_role FROM contact WHERE party_id = ${partyId}), true, CURRENT_DATE)
            `);
          }
        }
      }

      const detail = await db.execute(sql`${CONTACT_SELECT} WHERE c.party_id = ${partyId}`);
      return detail.rows[0] ?? null;
    });

    if (!updated) return res.status(404).json({ error: "contact not found" });
    res.json({ contact: updated });
  } catch (err) {
    if ((err as { code?: string }).code === "BAD_ACCOUNT") {
      return res.status(400).json({ error: "invalid accountPartyId" });
    }
    next(err);
  }
});
