// Public lead-intake endpoint for external forms (marketing site, landing
// pages, ad campaigns, WhatsApp bots, etc.).
//
// This is the ONE route on the API that is NOT gated by Auth0. Instead it
// requires two things:
//
//   1. An `X-Intake-Key` header matching env var INTAKE_API_KEY. The website
//      keeps the key in its own server env — never in HTML. Timing-safe
//      comparison so length/prefix leaks nothing.
//   2. A tiny in-memory per-IP rate limit (10 req / 60 s) so a leaked key
//      can't be turned into a spam firehose while you rotate it.
//
// Payload is the minimum viable lead — { name, email, phone, source?,
// sourceLabel?, notes? }. Everything else is derived: rating='new lead',
// score=50, stage='new', advisor='first admin', etc. Response returns
// { ok: true, number } so the client can show a confirmation.
//
// If any of the above fails we still return `{ ok: true }` publicly (so an
// attacker can't tell whether the key is right or whether the endpoint is
// rate-limiting them). The real error is logged server-side.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { withTenant } from "../db/app.js";
import { appPool } from "../db/app.js";
import { resolveSentinelPartyId } from "../lib/party/resolve.js";
import { emitEvent } from "../lib/events.js";

export const intakeRouter = Router();

// ─── Config ───────────────────────────────────────────────────────────────

const INTAKE_API_KEY = (process.env.INTAKE_API_KEY ?? "").trim();

// Per-IP rate limit: 10 requests per 60 seconds. In-memory Map — resets on
// process restart, which is fine for the intended purpose.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const rateHits = new Map<string, number[]>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const arr = (rateHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    rateHits.set(ip, arr);
    return false;
  }
  arr.push(now);
  rateHits.set(ip, arr);
  return true;
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function clientIp(req: import("express").Request): string {
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return xf || req.socket.remoteAddress || "unknown";
}

// ─── Tenant resolution (same as auth.ts, kept local so middleware stays clean) ─

let cachedTenantId: string | null = null;
async function resolveDefaultTenantId(): Promise<string | null> {
  if (cachedTenantId) return cachedTenantId;
  const fromEnv = process.env.DEFAULT_TENANT_ID?.trim();
  if (fromEnv && /^[0-9a-fA-F-]{36}$/.test(fromEnv)) {
    cachedTenantId = fromEnv;
    return cachedTenantId;
  }
  const r = await appPool.query<{ id: string }>(
    `SELECT id FROM tenant ORDER BY created_at DESC LIMIT 1`,
  );
  cachedTenantId = r.rows[0]?.id ?? null;
  return cachedTenantId;
}

// ─── Small helpers ───────────────────────────────────────────────────────

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_GRADS = ["magenta", "violet", "blue", "ochre", "ok", "mute", "vm"] as const;
function pickAvatar(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_GRADS[h % AVATAR_GRADS.length]!;
}

// ─── POST /leads/intake ──────────────────────────────────────────────────

intakeRouter.post("/", async (req, res) => {
  // Refuse to run at all if the key wasn't configured on the server.
  if (!INTAKE_API_KEY) {
    console.error("[intake] INTAKE_API_KEY is not set — refusing intake requests");
    return res.status(200).json({ ok: true });
  }

  const providedKey = String(req.headers["x-intake-key"] ?? "").trim();
  if (!providedKey || !safeEqual(providedKey, INTAKE_API_KEY)) {
    console.warn("[intake] bad api key from", clientIp(req));
    return res.status(200).json({ ok: true });
  }

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    console.warn("[intake] rate-limited", ip);
    return res.status(200).json({ ok: true });
  }

  // ── Validate payload — minimal fields only, everything else is derived.
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name  = String(b.name  ?? "").trim();
  const email = String(b.email ?? "").trim() || null;
  const phone = String(b.phone ?? "").trim() || null;
  // Optional — public forms send this alongside the local number so the CRM
  // can dial the lead without guessing the region.
  const phoneCountryCode = String(b.phoneCountryCode ?? "").trim() || null;
  const source      = String(b.source      ?? "web").trim() || "web";
  const sourceLabel = String(b.sourceLabel ?? "Website form").trim() || "Website form";
  const notes = String(b.notes ?? "").trim() || null;

  if (!name || (!email && !phone)) {
    // Public forms should surface a hint, but don't leak schema details.
    return res.status(400).json({ ok: false, error: "name and at least one of email or phone are required" });
  }

  // Honeypot — a hidden field that real users never fill. If we see something
  // here, silently drop the request.
  if (String(b.company ?? "").trim() !== "") {
    console.warn("[intake] honeypot triggered by", ip);
    return res.status(200).json({ ok: true });
  }

  const tenantId = await resolveDefaultTenantId();
  if (!tenantId) {
    console.error("[intake] no tenant found — DB not seeded?");
    return res.status(200).json({ ok: true });
  }

  try {
    const result = await withTenant(tenantId, async (db) => {
      const agentActorPartyId = await resolveSentinelPartyId(db, tenantId);

      // Advisor = first active admin (matches how POST /leads does it).
      const advR = await db.execute(sql`
        SELECT party_id FROM app_user WHERE role = 'admin' AND active = true
        ORDER BY created_at LIMIT 1
      `);
      const advisorId = (advR.rows[0] as { party_id: string } | undefined)?.party_id ?? null;

      // Human-readable number.
      const numR = await db.execute(sql`SELECT nextval('seq_lead')::text AS n`);
      const number = `LEAD-${(numR.rows[0] as { n: string }).n}`;

      // party
      const partyR = await db.execute(sql`
        INSERT INTO party (tenant_id, kind, name, email, phone, phone_country_code, identifiers, attributes)
        VALUES (
          current_tenant(), 'person', ${name}, ${email}, ${phone}, ${phoneCountryCode},
          ${JSON.stringify({ source })}::jsonb,
          ${JSON.stringify({ initials: initialsOf(name) })}::jsonb
        )
        RETURNING id
      `);
      const partyId = (partyR.rows[0] as { id: string }).id;

      // party_role = lead (starts today, open-ended)
      await db.execute(sql`
        INSERT INTO party_role (tenant_id, party_id, role, valid_from)
        VALUES (current_tenant(), ${partyId}, 'lead', current_date)
        ON CONFLICT (party_id, role, valid_from) DO NOTHING
      `);

      // work_item
      const wiR = await db.execute(sql`
        INSERT INTO work_item (
          tenant_id, number, type, party_id, assignee_id, state, priority, attributes
        )
        VALUES (
          current_tenant(), ${number}, 'lead', ${partyId}, ${advisorId}, 'open', 3,
          ${JSON.stringify({ source, sourceLabel })}::jsonb
        )
        RETURNING id, created_at
      `);
      const workItemId = (wiR.rows[0] as { id: string }).id;

      // lead — everything not supplied is a sane default
      await db.execute(sql`
        INSERT INTO lead (
          work_item_id, tenant_id, source, source_label, score, rating, stage, stage_label,
          heat, advisor_id, avatar, initials, description, nba_label, nba_icon
        )
        VALUES (
          ${workItemId}, current_tenant(), ${source}, ${sourceLabel}, 50, 'new lead',
          'new', 'New inbound', 'warm', ${advisorId}, ${pickAvatar(name)}, ${initialsOf(name)},
          ${notes}, 'Reach out today', 'send'
        )
      `);

      // Contact-point mirror — dual-write like POST /leads does.
      if (email) {
        await db.execute(sql`
          INSERT INTO contact_point (tenant_id, party_id, kind, value, is_primary)
          VALUES (current_tenant(), ${partyId}, 'email', ${email}, true)
          ON CONFLICT DO NOTHING
        `);
      }
      if (phone) {
        await db.execute(sql`
          INSERT INTO contact_point (tenant_id, party_id, kind, value, is_primary)
          VALUES (current_tenant(), ${partyId}, 'phone', ${phone}, true)
          ON CONFLICT DO NOTHING
        `);
      }

      // Activity — attributed to the sentinel (system/agent), since there's
      // no logged-in user creating this row.
      await db.execute(sql`
        INSERT INTO activity (
          tenant_id, work_item_id, party_id, actor_type, actor_party_id, actor_name,
          verb, detail, tag, payload, ts
        )
        VALUES (
          current_tenant(), ${workItemId}, ${partyId}, 'agent', ${agentActorPartyId}, 'System',
          'Lead captured', ${`New lead via ${sourceLabel}: ${name}`}, 'ai',
          ${JSON.stringify({ when: "Just now", quote: notes, source, ip })}::jsonb, NOW()
        )
      `);

      return { workItemId, number };
    });

    // Fire the domain event (Slack, WA automations, etc.). Never throws.
    // The context shape is fixed by lib/events.ts — pass defaults for the
    // fields the intake form doesn't collect.
    await emitEvent({
      type: "lead.created",
      tenantId,
      occurredAt: new Date().toISOString(),
      context: {
        leadId: result.workItemId,
        number: result.number,
        name,
        email,
        phone,
        city: null,
        program: null,
        source,
        sourceLabel,
        advisorName: null,
        stage: "new",
        score: 50,
        heat: "warm",
        rating: "new lead",
      },
    });

    return res.status(200).json({ ok: true, number: result.number });
  } catch (err) {
    console.error("[intake] failed:", (err as Error).message);
    return res.status(200).json({ ok: true });
  }
});
