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
      // The full set of users who can own tickets — admin + advisor + service_rep.
      const employees = await db.execute(sql`
        SELECT id, name, email, role FROM app_user
        WHERE active = true AND role IN ('admin','advisor','service_rep')
        ORDER BY
          CASE role WHEN 'admin' THEN 0 WHEN 'service_rep' THEN 1 ELSE 2 END,
          name
      `);
      // Every active user — used by the trainer / co-trainer pickers on batches
      // and anywhere else we want a tenant-wide person picker.
      const staff = await db.execute(sql`
        SELECT id, name, email, role FROM app_user
        WHERE active = true
        ORDER BY name
      `);
      const sources = [
        { key: "web",          label: "Website form" },
        { key: "instagram_ad", label: "Instagram ad" },
        { key: "referral",     label: "Referral" },
        { key: "webinar",      label: "Webinar" },
        { key: "paid",         label: "Paid search" },
      ];
      const ticketCategories = [
        { key: "billing",       label: "Billing" },
        { key: "technical",     label: "Technical" },
        { key: "content_lms",   label: "Content / LMS" },
        { key: "onboarding",    label: "Onboarding" },
        { key: "cohort_batch",  label: "Cohort / Batch" },
        { key: "refund",        label: "Refund" },
        { key: "certificate",   label: "Certificate" },
        { key: "other",         label: "Other" },
      ];
      const ticketPriorities = [
        { value: 1, label: "Urgent" },
        { value: 2, label: "High" },
        { value: 3, label: "Medium" },
        { value: 4, label: "Low" },
      ];
      const ticketStatuses = [
        { key: "open",        label: "Open" },
        { key: "in_progress", label: "In progress" },
        { key: "pending",     label: "Pending" },
        { key: "resolved",    label: "Resolved" },
        { key: "closed",      label: "Closed" },
        { key: "cancelled",   label: "Cancelled" },
      ];
      const resolutionCodes = [
        { key: "fixed",     label: "Fixed" },
        { key: "duplicate", label: "Duplicate" },
        { key: "wont_fix",  label: "Won't fix" },
        { key: "no_action", label: "No action needed" },
      ];
      return {
        programs: programs.rows,
        courses: courses.rows,
        advisors: advisors.rows,
        employees: employees.rows,
        staff: staff.rows,
        sources,
        ticketCategories,
        ticketPriorities,
        ticketStatuses,
        resolutionCodes,
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
