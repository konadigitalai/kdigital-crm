import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";

export const catalogRouter = Router();

// Used by the "New lead" form — we fill program/cohort/advisor dropdowns from real DB rows.
catalogRouter.get("/", async (req, res, next) => {
  try {
    const data = await withTenant(req.tenantId!, async (db) => {
      // Catalog is what dropdowns see — only enabled programs/cohorts.
      // Catalog is the bag of options the lead form / convert dialog needs.
      // No batches here — batches are picked on the learner record page.
      const programs = await db.execute(sql`
        SELECT id, name, track, price FROM program WHERE enabled = true ORDER BY name
      `);
      const courses = await db.execute(sql`
        SELECT co.id, co.name, co.code, co.program_id AS "programId", p.name AS "programName"
        FROM course co JOIN program p ON p.id = co.program_id
        WHERE co.enabled = true AND p.enabled = true
        ORDER BY p.name, co.name
      `);
      const advisors = await db.execute(sql`
        SELECT id, name, email, role FROM app_user
        WHERE active = true AND role IN ('admin','advisor')
        ORDER BY name
      `);
      const sources = [
        { key: "web",          label: "Website form" },
        { key: "instagram_ad", label: "Instagram ad" },
        { key: "referral",     label: "Referral" },
        { key: "webinar",      label: "Webinar" },
        { key: "paid",         label: "Paid search" },
      ];
      return {
        programs: programs.rows,
        courses: courses.rows,
        advisors: advisors.rows,
        sources,
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
