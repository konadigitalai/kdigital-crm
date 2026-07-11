// Exotel API — outbound click-to-call.
//
// Mounted at /exotel behind authMiddleware. Only one endpoint for now:
//   POST /exotel/call { to } → rings the advisor's mobile, then patches
//   the customer in. Persists a tw_message (channel='voice',
//   direction='outbound') + timeline activity so the record page can
//   show "You called Aarav" alongside SMS + WhatsApp events.
//
// The advisor's phone is read from app_user.phone; if unset, we fall back
// to EXOTEL_FALLBACK_AGENT_NUMBER ("call desk"). If both are missing,
// respond with a clear 400 so the FE can prompt the advisor to set one.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";
import { toE164 } from "../lib/twilio/phone.js";
import {
  matchOrCreatePartyByPhone,
  upsertConversation,
  recordOutbound,
  insertActivityForMessage,
} from "../lib/twilio/inbox.js";
import { readExotelConfig, ExotelNotConfigured, initiateCall } from "../lib/exotel/client.js";
import { filterConsentedRecipients } from "../lib/party/consent.js";

export const exotelRouter = Router();

// ─── Per-user in-memory rate limit (30 calls/min) ────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const userHits = new Map<string, number[]>();
function rateLimit(userKey: string): boolean {
  const now = Date.now();
  const arr = (userHits.get(userKey) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { userHits.set(userKey, arr); return false; }
  arr.push(now);
  userHits.set(userKey, arr);
  return true;
}

// ─── POST /exotel/call ───────────────────────────────────────────────────
// Body: { to: "+91..." or "LEAD-XXXX" }
// Response 200: { ok, conversationId, messageId, callSid }
// Response 400: { error, code } — no phone / no consent / no advisor phone
// Response 503: { error } — Exotel not configured

exotelRouter.post("/call", requirePermission("messaging.send"), async (req, res, next) => {
  try {
    const to = String((req.body as { to?: unknown })?.to ?? "").trim();
    if (!to) return res.status(400).json({ error: "to is required" });

    // Rate limit before any DB work.
    const userKey = String(req.userId ?? req.headers["x-forwarded-for"] ?? "anon");
    if (!rateLimit(userKey)) {
      return res.status(429).json({ error: "too many call attempts — wait a minute" });
    }

    // Ensure Exotel is configured before we touch the DB.
    let cfg;
    try { cfg = readExotelConfig(); }
    catch (e) {
      if (e instanceof ExotelNotConfigured) return res.status(503).json({ error: e.message });
      throw e;
    }

    const result = await withTenant(req.tenantId!, async (db) => {
      // ── Resolve target (E.164 or LEAD-XXXX) ──────────────────────────
      const target = await resolveTargetParty(db, to);
      if (!target) return { kind: "unknown-target" as const };
      if (!target.partyPhone) return { kind: "no-phone" as const };

      // ── Actor + advisor phone ────────────────────────────────────────
      const actorPartyId = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const advisorRow = await db.execute(sql`
        SELECT phone, name FROM app_user WHERE id = ${req.userId} LIMIT 1
      `);
      const advisor = advisorRow.rows[0] as { phone: string | null; name: string | null } | undefined;
      const rawAdvisorPhone = (advisor?.phone ?? "").trim();
      const advisorPhone =
        rawAdvisorPhone ? toE164(rawAdvisorPhone) :
        cfg.fallbackAgentNumber || "";
      const usingFallback = !rawAdvisorPhone && !!cfg.fallbackAgentNumber;
      if (!advisorPhone) {
        return { kind: "no-advisor-phone" as const };
      }

      // ── Consent gate (calls channel) ─────────────────────────────────
      const consented = await filterConsentedRecipients(db, "calls", [target.partyId]);
      if (consented.allowed.length === 0) {
        const reason = consented.blocked[0]?.reason ?? "no_consent";
        return { kind: "no-consent" as const, reason };
      }

      // ── Fire the Exotel call ─────────────────────────────────────────
      const send = await initiateCall({
        agentPhone:    advisorPhone,
        customerPhone: target.partyPhone,
        customField:   target.workItemId ?? "",
        record:        true,
      }, cfg);

      // ── Persist outbound tw_message + activity ───────────────────────
      const conv = await upsertConversation(db, target.partyId, "voice", target.workItemId == null);
      const messageId = await recordOutbound(db, conv.id, {
        channel: "voice",
        fromE164: cfg.virtualNumber,   // display: our ExoPhone is the "from"
        toE164:   target.partyPhone,
        body:     "",
        senderUserPartyId: actorPartyId,
        send: {
          ok:                send.ok,
          providerMessageId: send.callSid,
          errorCode:         send.errorCode,
          errorMessage:      send.errorMessage,
          response:          send.response,
        },
      });

      // Timeline row — one per initiated call. Duration lands in a later
      // update from the terminal StatusCallback; for now the row just
      // says the call was started + by whom.
      await insertActivityForMessage(db, {
        workItemId: target.workItemId,
        partyId:    target.partyId,
        actorType:  "user",
        actorPartyId,
        actorName:  advisor?.name ?? req.user?.name ?? "You",
        direction:  "outbound",
        channel:    "voice",
        body:       usingFallback
                      ? "Call started via team call desk"
                      : `Call started · ringing ${advisorPhone}`,
        mediaCount: 0,
        mediaMimes: [],
      });

      return {
        kind:            "ok" as const,
        conversationId:  conv.id,
        messageId,
        callSid:         send.callSid,
        exotelOk:        send.ok,
        errorCode:       send.errorCode,
        errorMessage:    send.errorMessage,
        usingFallback,
      };
    });

    // Envelope every failure with a distinct code the FE can render.
    if (result.kind === "unknown-target")   return res.status(400).json({ error: `Unknown lead or invalid phone: ${to}`, code: "unknown_target" });
    if (result.kind === "no-phone")         return res.status(400).json({ error: `No phone number for ${to}`, code: "no_phone" });
    if (result.kind === "no-advisor-phone") return res.status(400).json({ error: "Your Advisor profile has no phone number. Set one under Settings → Advisors, or ask an admin to configure EXOTEL_FALLBACK_AGENT_NUMBER.", code: "no_advisor_phone" });
    if (result.kind === "no-consent")       return res.status(400).json({ error: `This lead has not opted in for calls (${result.reason})`, code: "no_consent" });

    return res.json(result);
  } catch (err) { next(err); }
});

// ─── helpers ─────────────────────────────────────────────────────────────

/** Duplicate of the twilio.ts resolveToParty helper — doesn't throw on
 *  invalid input, returns null so the caller can respond with a clean 400. */
async function resolveTargetParty(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  to: string,
): Promise<{ partyId: string; partyPhone: string | null; workItemId: string | null } | null> {
  const trimmed = to.trim();
  const looksLikePhone = /^\+?\d[\d\s\-()]*$/.test(trimmed);
  if (looksLikePhone) {
    const asPhone = toE164(trimmed);
    if (!asPhone || asPhone.length < 8) return null;
    const lookup = await matchOrCreatePartyByPhone(db, asPhone);
    return {
      partyId:    lookup.partyId,
      partyPhone: asPhone,
      workItemId: lookup.leadWorkItemId,
    };
  }
  // Lead-number lookup with composed phone.
  const r = await db.execute(sql`
    SELECT
      wi.id       AS "workItemId",
      wi.party_id AS "partyId",
      p.phone_country_code AS "cc",
      p.phone     AS "phone"
    FROM work_item wi JOIN party p ON p.id = wi.party_id
    WHERE wi.number = ${trimmed} AND wi.type = 'lead'
    LIMIT 1
  `);
  const row = r.rows[0] as {
    workItemId: string; partyId: string; cc: string | null; phone: string | null;
  } | undefined;
  if (!row) return null;
  return {
    workItemId: row.workItemId,
    partyId:    row.partyId,
    partyPhone: composeE164(row.cc, row.phone),
  };
}

/** Same composeFullE164 shape as elsewhere — inline here to avoid pulling
 *  a circular import from routes/twilio.ts. */
function composeE164(cc: string | null, phone: string | null): string | null {
  const rawPhone = (phone ?? "").trim();
  if (!rawPhone) return null;
  const phoneDigits = rawPhone.replace(/\D/g, "");
  if (rawPhone.startsWith("+") && phoneDigits.length > 10) return `+${phoneDigits}`;
  const ccDigits = (cc ?? "").replace(/\D/g, "");
  if (ccDigits) return `+${ccDigits}${phoneDigits}`;
  if (phoneDigits.length === 10 && /^[6-9]/.test(phoneDigits)) return `+91${phoneDigits}`;
  return null;
}
