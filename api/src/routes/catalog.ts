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
        SELECT p.id, p.name, p.price, p.family, p.short_code AS "shortCode"
        FROM program p
        WHERE p.enabled = true
        ORDER BY s.name NULLS LAST, p.name
      `);
      const courses = await db.execute(sql`
        SELECT co.id, co.name, co.description
        FROM course co
        WHERE co.enabled = true
        ORDER BY co.name
      `);
      const advisors = await db.execute(sql`
        SELECT id, name, email, role FROM app_user
        WHERE active = true AND role IN ('admin','advisor')
        ORDER BY name
      `);
      // The full set of users who can own cases — admin + advisor + service_rep.
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
        { key: "web",            label: "Web" },
        { key: "email",          label: "Email" },
        { key: "phone",          label: "Phone" },
        { key: "chat",           label: "Chat" },
        { key: "web_form",       label: "Web Form" },
        { key: "referral",       label: "Referral" },
        { key: "paid",           label: "Paid Search" },
        { key: "demo",           label: "Demo" },
        { key: "organic_search", label: "Organic Search" },
      ];
      // Lead workflow status — separate from `rating` (heat) and `stage`
      // (pipeline bucket). CHECK constraint on `lead.lead_status` mirrors
      // these keys (see migration post-0061).
      const leadStatuses = [
        { key: "new",                        label: "New" },
        { key: "contacted",                  label: "Contacted" },
        { key: "interested",                 label: "Interested" },
        { key: "demo_attended",              label: "Demo Attended" },
        { key: "visiting",                   label: "Visiting" },
        { key: "payment_link_sent",          label: "Payment Link Sent" },
        { key: "enrolled",                   label: "Enrolled" },
        { key: "lost_lead",                  label: "Lost Lead" },
        { key: "visited",                    label: "Visited" },
        { key: "interested_in_demo",         label: "Interested in Demo" },
        { key: "advance_talk_with_trainer",  label: "Advance Talk With Trainer" },
        { key: "unqualified",                label: "Unqualified" },
      ];
      const caseCategories = [
        { key: "billing",       label: "Billing" },
        { key: "technical",     label: "Technical" },
        { key: "content_lms",   label: "Content / LMS" },
        { key: "onboarding",    label: "Onboarding" },
        { key: "cohort_batch",  label: "Cohort / Batch" },
        { key: "refund",        label: "Refund" },
        { key: "certificate",   label: "Certificate" },
        { key: "data_privacy",  label: "Data / Privacy" },
        { key: "other",         label: "Other" },
      ];
      const casePriorities = [
        { value: 1, label: "Urgent" },
        { value: 2, label: "High" },
        { value: 3, label: "Medium" },
        { value: 4, label: "Low" },
      ];
      const caseStatuses = [
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
      // Slack integration — drives the rule editor's event dropdown.
      const slackEvents = [
        { type: "lead.created", label: "Lead created", hint: "When a new lead enters the pipeline" },
        { type: "case.opened",  label: "Case opened",  hint: "When a support case is created" },
        { type: "case.closed",  label: "Case closed",  hint: "When a support case is closed" },
      ];
      return {
        programs: programs.rows,
        courses: courses.rows,
        advisors: advisors.rows,
        employees: employees.rows,
        staff: staff.rows,
        sources,
        leadStatuses,
        caseCategories,
        casePriorities,
        caseStatuses,
        resolutionCodes,
        slackEvents,
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
