// Media library + attachment API.
//
// Mounted at /media behind authMiddleware. Every handler enforces its own
// permission gate.
//
// Two flows to know:
//   1. Direct-to-Blob uploads — FE calls @vercel/blob/client `upload()`,
//      which POSTs to /media/upload-token (twice: token-generate then
//      completion). We authorise + persist the media_asset row.
//   2. Library CRUD — /media/folders + /media/assets are ordinary REST.
//
// Inbound Twilio media is Basic-auth gated. /media/proxy/:id fetches
// server-side with those credentials and streams the bytes to the browser.

import { Router } from "express";
import { sql } from "drizzle-orm";
import { withTenant } from "../db/app.js";
import { requirePermission } from "../middleware/require.js";
import { resolveActorPartyId } from "../lib/party/resolve.js";
import {
  handleBlobUpload, deleteBlob, tenantPathname,
  BlobNotConfigured, type AuthorizedUpload,
} from "../lib/blob.js";
import type { HandleUploadBody } from "@vercel/blob/client";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
} from "../lib/twilio/media.js";
import {
  accessTokenFor, getAttachment, type GmailAccountRow,
} from "../lib/gmail/client.js";
import { readTwilioAuthToken, readTwilioConfig } from "../lib/twilio/client.js";
import { readExotelBasicAuth } from "../lib/exotel/client.js";
import type { DbExec } from "../lib/twilio/inbox.js";

export const mediaRouter = Router();

// ─── POST /media/upload-token ────────────────────────────────────────────
// The FE @vercel/blob/client.upload() calls this endpoint to get a
// short-lived client token. The browser then PUTs the file to Vercel Blob
// directly, and the FE calls POST /media/assets afterwards to record the
// completed upload.
//
// (We deliberately do NOT use Vercel's onUploadCompleted webhook — that
// requires Vercel's servers to reach our API, which fails on localhost and
// any private network. Doing the DB insert from the FE after upload is
// simpler and works everywhere.)

mediaRouter.post("/upload-token", requirePermission("media.upload"), async (req, res, next) => {
  try {
    const body = req.body as HandleUploadBody;
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const tenantId = req.tenantId!;
    const userId = req.userId!;

    const out = await handleBlobUpload({
      body,
      request,
      authorize: async (pathname, clientPayload) => {
        let extras: { folderId?: string | null; isLibrary?: boolean } = {};
        if (clientPayload) {
          try { extras = JSON.parse(clientPayload); } catch { /* ignore malformed */ }
        }
        return await withTenant(tenantId, async (db) => {
          const uploadedBy = await resolveActorPartyId(db, tenantId, userId);
          const authz: AuthorizedUpload = {
            tenantId,
            uploadedBy,
            folderId: extras.folderId ?? null,
            isLibrary: !!extras.isLibrary,
            maxSizeBytes: MAX_UPLOAD_BYTES,
            allowedContentTypes: ALLOWED_UPLOAD_CONTENT_TYPES,
          };
          if (authz.folderId) {
            const r = await db.execute(sql`
              SELECT 1 FROM media_folder WHERE id = ${authz.folderId} LIMIT 1
            `);
            if (r.rowCount === 0) throw new Error("Unknown folder");
          }
          void pathname;
          return authz;
        });
      },
      // No-op — kept because Vercel's SDK type requires the field to exist.
      // We do the DB insert from the FE post-upload via POST /media/assets.
      onCompleted: async () => {},
    });

    return res.json(out);
  } catch (err) {
    if (err instanceof BlobNotConfigured) {
      return res.status(503).json({ error: err.message });
    }
    next(err);
  }
});

// ─── POST /media/assets ──────────────────────────────────────────────────
// Called by the FE after a browser→Blob upload finishes. Records the
// upload as a media_asset row and returns the freshly-created row so the
// UI can display it immediately.
//
// The Blob URL itself is sufficient proof-of-upload — anyone with the URL
// has evidence Vercel accepted the bytes, and Vercel already enforced the
// per-upload size + content-type caps we set in the client token.

mediaRouter.post("/assets", requirePermission("media.upload"), async (req, res, next) => {
  try {
    const b = req.body as {
      filename?: string; contentType?: string; sizeBytes?: number;
      blobUrl?: string; blobPathname?: string;
      folderId?: string | null; isLibrary?: boolean;
    };
    const filename = String(b.filename ?? "").trim();
    const contentType = String(b.contentType ?? "").trim();
    const blobUrl = String(b.blobUrl ?? "").trim();
    const blobPathname = String(b.blobPathname ?? "").trim() || null;
    const sizeBytes = Number(b.sizeBytes ?? 0);
    if (!filename || !contentType || !blobUrl) {
      return res.status(400).json({ error: "filename, contentType, blobUrl are required" });
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) {
      return res.status(400).json({ error: `File exceeds ${MAX_UPLOAD_BYTES / (1024*1024)} MB storage cap` });
    }
    if (!ALLOWED_UPLOAD_CONTENT_TYPES.includes(contentType)) {
      return res.status(400).json({ error: `Content type ${contentType} not allowed` });
    }
    const folderId = b.folderId ?? null;
    const isLibrary = !!b.isLibrary;

    const out = await withTenant(req.tenantId!, async (db) => {
      const actor = await resolveActorPartyId(db, req.tenantId!, req.userId);
      if (folderId) {
        const f = await db.execute(sql`SELECT 1 FROM media_folder WHERE id = ${folderId} LIMIT 1`);
        if (f.rowCount === 0) return { kind: "bad-folder" as const };
      }
      // Only enforce uniqueness for library-scoped assets — ad-hoc uploads
      // attached to a single message are never visible in the library, so
      // duplicate filenames there don't hurt anyone.
      if (isLibrary && await libraryNameTaken(db, folderId, filename, null)) {
        return { kind: "duplicate" as const };
      }
      const r = await db.execute(sql`
        INSERT INTO media_asset (
          tenant_id, folder_id, uploaded_by, filename,
          content_type, size_bytes, blob_url, blob_pathname,
          is_library, source, provider_hosted
        )
        VALUES (
          current_tenant(), ${folderId}, ${actor},
          ${filename}, ${contentType}, ${sizeBytes},
          ${blobUrl}, ${blobPathname},
          ${isLibrary}, 'user_upload', false
        )
        RETURNING
          id, filename, content_type AS "contentType", size_bytes AS "sizeBytes",
          blob_url AS "blobUrl", is_library AS "isLibrary", source,
          provider_hosted AS "providerHosted", uploaded_by AS "uploadedBy",
          folder_id AS "folderId", created_at AS "createdAt"
      `);
      return { kind: "ok" as const, asset: r.rows[0] };
    });
    if (out.kind === "bad-folder") return res.status(400).json({ error: "Unknown folder" });
    if (out.kind === "duplicate")  return res.status(409).json({ error: "A library file with that name already exists in this folder. Rename it or pick a different folder." });
    return res.status(201).json(out.asset);
  } catch (err) { next(err); }
});

// ─── Client-signalled upload path helper (optional; FE sends this) ───────
// FE can call GET /media/upload-path?filename=x.pdf&contentType=application/pdf
// to get a pre-normalised pathname to embed in @vercel/blob/client's upload().
// Not strictly required — the SDK will pick a pathname on its own — but
// letting the API decide keeps the tenant-scoping conventions consistent.

mediaRouter.get("/upload-path", requirePermission("media.upload"), (req, res) => {
  const filename = String(req.query.filename ?? "").trim() || "file";
  return res.json({ pathname: tenantPathname(req.tenantId!, filename) });
});

// ─── GET /media/folders ──────────────────────────────────────────────────

mediaRouter.get("/folders", requirePermission("media.read"), async (req, res, next) => {
  try {
    const rows = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT
          f.id, f.name, f.created_at AS "createdAt", f.created_by AS "createdBy",
          (SELECT COUNT(*)::int FROM media_asset a
             WHERE a.folder_id = f.id AND a.deleted_at IS NULL) AS "assetCount"
        FROM media_folder f
        ORDER BY lower(f.name) ASC
      `);
      return r.rows;
    });
    return res.json({ folders: rows });
  } catch (err) { next(err); }
});

// ─── POST /media/folders ─────────────────────────────────────────────────

mediaRouter.post("/folders", requirePermission("media.manage"), async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name)                return res.status(400).json({ error: "name is required" });
    if (name.length > 80)     return res.status(400).json({ error: "name is too long" });
    const out = await withTenant(req.tenantId!, async (db) => {
      const actor = await resolveActorPartyId(db, req.tenantId!, req.userId);
      // Detect the duplicate ourselves. The unique index is partial (over
      // lower(name)); PostgreSQL requires the ON CONFLICT target to match
      // the index's WHERE, and we can't reliably express `lower(...)` in
      // a target-list without a real constraint. Cheaper + clearer: check
      // then insert. RLS + tenant scoping already keep names per tenant.
      const dupR = await db.execute(sql`
        SELECT 1 FROM media_folder
        WHERE lower(name) = lower(${name})
        LIMIT 1
      `);
      if (dupR.rowCount) return { kind: "duplicate" as const };
      const r = await db.execute(sql`
        INSERT INTO media_folder (tenant_id, name, created_by)
        VALUES (current_tenant(), ${name}, ${actor})
        RETURNING id, name, created_at AS "createdAt", created_by AS "createdBy"
      `);
      return { kind: "ok" as const, folder: r.rows[0] };
    });
    if (out.kind === "duplicate") return res.status(409).json({ error: "A folder with that name already exists" });
    return res.status(201).json(out.folder);
  } catch (err) { next(err); }
});

// ─── PATCH /media/folders/:id ────────────────────────────────────────────

mediaRouter.patch("/folders/:id", requirePermission("media.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    await withTenant(req.tenantId!, async (db) => {
      await db.execute(sql`UPDATE media_folder SET name = ${name} WHERE id = ${id}`);
    });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE /media/folders/:id ───────────────────────────────────────────

mediaRouter.delete("/folders/:id", requirePermission("media.manage"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    await withTenant(req.tenantId!, async (db) => {
      // Assets in this folder get folder_id set to null (per FK SET NULL).
      await db.execute(sql`DELETE FROM media_folder WHERE id = ${id}`);
    });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GET /media/assets ───────────────────────────────────────────────────
// Query: ?folder_id=<uuid|null>&scope=library|mine|all

mediaRouter.get("/assets", requirePermission("media.read"), async (req, res, next) => {
  try {
    const folderId = String(req.query.folder_id ?? "").trim();
    const scope = String(req.query.scope ?? "library").trim().toLowerCase();
    const rows = await withTenant(req.tenantId!, async (db) => {
      const actor = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const r = await db.execute(sql`
        SELECT
          a.id, a.filename, a.content_type AS "contentType",
          a.size_bytes AS "sizeBytes",
          a.blob_url AS "blobUrl",
          a.is_library AS "isLibrary",
          a.source, a.provider_hosted AS "providerHosted",
          a.uploaded_by AS "uploadedBy",
          a.folder_id AS "folderId",
          a.created_at AS "createdAt",
          f.name AS "folderName"
        FROM media_asset a
        LEFT JOIN media_folder f ON f.id = a.folder_id
        WHERE a.deleted_at IS NULL
          AND (
            ${scope === "library"} AND a.is_library = true
            OR ${scope === "mine"} AND a.uploaded_by = ${actor}
            OR ${scope === "all"}
          )
          AND (${folderId === ""} OR a.folder_id::text = ${folderId})
        ORDER BY a.created_at DESC
        LIMIT 500
      `);
      return r.rows;
    });
    return res.json({ assets: rows });
  } catch (err) { next(err); }
});

// ─── PATCH /media/assets/:id — rename, move folders, toggle library ─────
// Owner OR media.manage.

mediaRouter.patch("/assets/:id", requirePermission("media.upload"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const patch = req.body as { filename?: string; folderId?: string | null; isLibrary?: boolean };
    const canManage = req.permissions?.has("media.manage") ?? false;
    const out = await withTenant(req.tenantId!, async (db) => {
      const actor = await resolveActorPartyId(db, req.tenantId!, req.userId);
      // Grab the current row so we can compute the post-patch shape without
      // a second round-trip (needed to compare against library-uniqueness).
      const cur = await db.execute(sql`
        SELECT uploaded_by AS "uploadedBy",
               filename, folder_id AS "folderId", is_library AS "isLibrary"
        FROM media_asset WHERE id = ${id} LIMIT 1
      `);
      const row = cur.rows[0] as
        | { uploadedBy: string | null; filename: string; folderId: string | null; isLibrary: boolean }
        | undefined;
      if (!row)                                     return { kind: "not-found" as const };
      if (row.uploadedBy !== actor && !canManage)   return { kind: "forbidden" as const };

      // Effective post-patch shape.
      const nextFilename  = typeof patch.filename === "string" && patch.filename.trim() ? patch.filename.trim() : row.filename;
      const nextFolderId  = patch.folderId !== undefined ? patch.folderId : row.folderId;
      const nextIsLibrary = typeof patch.isLibrary === "boolean" ? patch.isLibrary : row.isLibrary;

      // If we're changing something that affects library-uniqueness and the
      // resulting row would be in the library, re-check for a collision.
      const nameChanging   = typeof patch.filename === "string" && patch.filename.trim() && patch.filename.trim() !== row.filename;
      const folderChanging = patch.folderId !== undefined && patch.folderId !== row.folderId;
      const nowInLibrary   = typeof patch.isLibrary === "boolean" && patch.isLibrary && !row.isLibrary;
      if (nextIsLibrary && (nameChanging || folderChanging || nowInLibrary)) {
        if (await libraryNameTaken(db, nextFolderId, nextFilename, id)) {
          return { kind: "duplicate" as const };
        }
      }

      const sets: ReturnType<typeof sql>[] = [];
      if (typeof patch.filename === "string" && patch.filename.trim()) sets.push(sql`filename = ${patch.filename.trim()}`);
      if (patch.folderId !== undefined) sets.push(sql`folder_id = ${patch.folderId}`);
      if (typeof patch.isLibrary === "boolean") sets.push(sql`is_library = ${patch.isLibrary}`);
      if (sets.length === 0) return { kind: "ok" as const };
      await db.execute(sql`UPDATE media_asset SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
      return { kind: "ok" as const };
    });
    if (out.kind === "not-found") return res.status(404).json({ error: "Not found" });
    if (out.kind === "forbidden") return res.status(403).json({ error: "You can only edit your own uploads" });
    if (out.kind === "duplicate") return res.status(409).json({ error: "A library file with that name already exists in this folder." });
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── DELETE /media/assets/:id — soft-delete + free blob bytes ───────────

mediaRouter.delete("/assets/:id", requirePermission("media.upload"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const canManage = req.permissions?.has("media.manage") ?? false;
    const out = await withTenant(req.tenantId!, async (db) => {
      const actor = await resolveActorPartyId(db, req.tenantId!, req.userId);
      const owner = await db.execute(sql`
        SELECT uploaded_by AS "uploadedBy",
               blob_pathname AS "pathname",
               provider_hosted AS "providerHosted",
               EXISTS (SELECT 1 FROM tw_message_media m WHERE m.asset_id = media_asset.id) AS "inUse"
        FROM media_asset WHERE id = ${id} LIMIT 1
      `);
      const row = owner.rows[0] as {
        uploadedBy: string | null; pathname: string | null;
        providerHosted: boolean; inUse: boolean;
      } | undefined;
      if (!row)                                     return { kind: "not-found" as const };
      if (row.uploadedBy !== actor && !canManage)   return { kind: "forbidden" as const };
      if (row.inUse) {
        // Soft-delete only; keeps the blob so old message threads still render.
        await db.execute(sql`UPDATE media_asset SET deleted_at = now() WHERE id = ${id}`);
        return { kind: "soft" as const };
      }
      // Free the blob for uploads we own; leave Twilio-hosted URLs alone.
      if (row.pathname && !row.providerHosted) {
        try { await deleteBlob(row.pathname); }
        catch (err) { console.warn("[media] blob delete failed (continuing):", (err as Error).message); }
      }
      await db.execute(sql`DELETE FROM media_asset WHERE id = ${id}`);
      return { kind: "hard" as const };
    });
    if (out.kind === "not-found") return res.status(404).json({ error: "Not found" });
    if (out.kind === "forbidden") return res.status(403).json({ error: "You can only delete your own uploads" });
    return res.json({ ok: true, deleted: out.kind });
  } catch (err) { next(err); }
});

// ─── GET /media/proxy/:id ───────────────────────────────────────────────
// Streams the underlying blob to the caller. Used for provider-hosted
// (Twilio) URLs which need Basic auth to fetch; also works transparently
// for Vercel Blob URLs.

mediaRouter.get("/proxy/:id", requirePermission("media.read"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const meta = await withTenant(req.tenantId!, async (db) => {
      const r = await db.execute(sql`
        SELECT filename, content_type AS "contentType",
               blob_url AS "blobUrl",
               provider_hosted AS "providerHosted",
               source
        FROM media_asset WHERE id = ${id} LIMIT 1
      `);
      return r.rows[0] as
        | { filename: string; contentType: string; blobUrl: string; providerHosted: boolean; source: string }
        | undefined;
    });
    if (!meta) return res.status(404).json({ error: "Not found" });

    // Gmail attachments aren't fetchable by URL at all — they're an authorized
    // API call per (message, attachment) that returns base64. So they can't go
    // through the stream-an-upstream path below; we resolve the bytes here and
    // send them directly.
    if (meta.source === "gmail_attachment") {
      const buf = await fetchGmailAttachment(meta.blobUrl);
      if (!buf) return res.status(502).json({ error: "Could not fetch Gmail attachment" });
      res.setHeader("Content-Type", meta.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Disposition", `inline; filename="${meta.filename.replace(/"/g, "")}"`);
      return res.send(buf);
    }

    const headers: Record<string, string> = {};
    if (meta.providerHosted) {
      // Provider-hosted URLs need Basic auth. Which credentials depends on
      // which provider hosts the asset — the `source` column is our
      // discriminator. Falling through to no-auth is fatal for these URLs.
      if (meta.source === "twilio_inbound") {
        try {
          const cfg = readTwilioConfig();
          headers.Authorization = `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`, "utf8").toString("base64")}`;
        } catch {
          return res.status(502).json({ error: "Twilio not configured; cannot proxy inbound media" });
        }
        void readTwilioAuthToken();
      } else if (meta.source === "exotel_recording") {
        const auth = readExotelBasicAuth();
        if (!auth) return res.status(502).json({ error: "Exotel not configured; cannot proxy recording" });
        headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`, "utf8").toString("base64")}`;
      } else {
        // Unknown provider — we don't know what auth to send.
        return res.status(500).json({ error: `Unknown provider source: ${meta.source}` });
      }
    }

    const upstream = await fetch(meta.blobUrl, { headers });
    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status || 502).json({ error: "Upstream fetch failed" });
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? meta.contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Disposition", `inline; filename="${meta.filename.replace(/"/g, "")}"`);
    // Stream through. Node 20's fetch returns a web ReadableStream; convert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Readable } = await import("node:stream");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) { next(err); }
});

// ─── Gmail attachment resolution ─────────────────────────────────────────
//
// Gmail attachments have no fetchable URL, so at ingest we store a locator
// instead of one:
//
//   gmail://<gmailAccountId>/<gmailMessageId>/<attachmentId>
//
// Resolving it means an OAuth'd API call as the mailbox that received the mail.
// The alternative — downloading every attachment to Vercel Blob at ingest —
// would have us paying to store copies of every PDF anyone ever emailed us.
// The tradeoff: if the mailbox is disconnected or the mail is deleted from
// Gmail, the attachment stops resolving. Same bargain we already accept for
// Exotel call recordings.

// Shared by BOTH /media/proxy/:id (authenticated) and /media/fetch/:id (public
// signed URL). Keeping one function is the point: this file already carries a
// comment about /media/proxy growing a source-switch that /media/fetch didn't,
// which broke Exotel recording playback. Don't reintroduce that split.
//
// Takes no tenantId — the public signed-URL route has no tenant context. We
// resolve the tenant from the account row itself, then do the token work inside
// withTenant so RLS and the token-refresh UPDATE both behave normally.
async function fetchGmailAttachment(locator: string): Promise<Buffer | null> {
  const m = locator.match(/^gmail:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, accountId, messageId, attachmentId] = m;
  try {
    const { appPool } = await import("../db/app.js");
    const owner = await appPool.query<{ tenantId: string }>(
      `SELECT tenant_id AS "tenantId" FROM gmail_account WHERE id = $1 LIMIT 1`,
      [accountId],
    );
    const tenantId = owner.rows[0]?.tenantId;
    if (!tenantId) return null;

    return await withTenant(tenantId, async (db) => {
      const r = await db.execute(sql`
        SELECT id, email, refresh_token AS "refreshToken", access_token AS "accessToken",
               expires_at AS "expiresAt", history_id AS "historyId",
               app_user_id AS "appUserId", is_shared AS "isShared"
        FROM gmail_account WHERE id = ${accountId} LIMIT 1
      `);
      const account = r.rows[0] as unknown as GmailAccountRow | undefined;
      if (!account) return null;
      const token = await accessTokenFor(db, account);
      return await getAttachment(token, messageId!, attachmentId!);
    });
  } catch (err) {
    console.error("[media] gmail attachment fetch failed:", (err as Error).message);
    return null;
  }
}

// ─── Public signed-fetch router (for Twilio outbound media) ──────────────
//
// Mounted at /media/fetch in index.ts BEFORE authMiddleware — Twilio has
// no JWT. Auth is a short-lived HMAC signature over (assetId, expiry)
// signed with TWILIO_AUTH_TOKEN (an existing shared secret). URLs stop
// working after `exp`; default 15 minutes.
//
// Content-Disposition uses the user-facing filename so WhatsApp shows a
// clean name (e.g. "Full-AI-Stack-Curriculum.pdf") instead of the internal
// Blob pathname (which carries a random suffix for storage uniqueness).

import { createHmac, timingSafeEqual as timingSafeEqualBuf } from "node:crypto";

const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

export function signMediaFetchUrl(assetId: string, apiBaseUrl: string): string {
  const secret = (process.env.TWILIO_AUTH_TOKEN ?? "").trim();
  if (!secret) throw new Error("Cannot sign media URL — TWILIO_AUTH_TOKEN not set");
  const exp = Date.now() + SIGNED_URL_TTL_MS;
  const sig = createHmac("sha256", secret).update(`${assetId}|${exp}`).digest("hex");
  return `${apiBaseUrl.replace(/\/$/, "")}/media/fetch/${encodeURIComponent(assetId)}?exp=${exp}&sig=${sig}`;
}

function verifyMediaFetchSig(assetId: string, exp: number, sig: string): boolean {
  const secret = (process.env.TWILIO_AUTH_TOKEN ?? "").trim();
  if (!secret) return false;
  if (Number.isNaN(exp) || Date.now() > exp) return false;
  const expected = createHmac("sha256", secret).update(`${assetId}|${exp}`).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqualBuf(a, b);
}

export const mediaFetchRouter = Router();

mediaFetchRouter.get("/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const exp = Number(req.query.exp ?? 0);
    const sig = String(req.query.sig ?? "");
    if (!verifyMediaFetchSig(id, exp, sig)) {
      return res.status(403).type("text/plain").send("forbidden");
    }

    // No tenant context (Twilio has no JWT). Signed URL is the auth. Use
    // the raw admin pool but scoped to the asset id — cross-tenant asset
    // access is prevented by the signature (attacker can't forge an ID
    // for a different tenant's asset without our secret).
    const { appPool } = await import("../db/app.js");
    const q = await appPool.query<{
      filename: string; contentType: string; blobUrl: string; providerHosted: boolean;
      source: string;
    }>(
      `SELECT filename, content_type AS "contentType",
              blob_url AS "blobUrl",
              provider_hosted AS "providerHosted",
              source
       FROM media_asset WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id],
    );
    const meta = q.rows[0];
    if (!meta) return res.status(404).type("text/plain").send("not found");

    // Gmail attachments have no fetchable URL — they're an authorized API call
    // that returns base64, so they can't use the stream-an-upstream path below.
    // This is the route the thread UI's <img>/<a> tags actually hit (they can't
    // send a JWT), so it MUST handle the source, not just /media/proxy.
    if (meta.source === "gmail_attachment") {
      const buf = await fetchGmailAttachment(meta.blobUrl);
      if (!buf) return res.status(502).type("text/plain").send("gmail attachment fetch failed");
      res.setHeader("Content-Type", meta.contentType);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Content-Disposition", `attachment; filename="${meta.filename.replace(/"/g, "")}"`);
      return res.send(buf);
    }

    const headers: Record<string, string> = {};
    if (meta.providerHosted) {
      // Provider-hosted URLs need Basic auth. The `source` column tells us
      // which provider — Twilio and Exotel use different credentials, and
      // sending Twilio auth to `recordings.exotel.com` gets a 401 (which
      // is exactly the bug this branch used to have — the /media/proxy
      // handler grew a source-switch but /media/fetch did not).
      if (meta.source === "exotel_recording") {
        const auth = readExotelBasicAuth();
        if (!auth) return res.status(502).type("text/plain").send("exotel not configured");
        headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`, "utf8").toString("base64")}`;
      } else if (meta.source === "twilio_inbound") {
        try {
          const cfg = readTwilioConfig();
          const basic = Buffer.from(`${cfg.sid}:${cfg.token}`, "utf8").toString("base64");
          headers.Authorization = `Basic ${basic}`;
        } catch {
          return res.status(502).type("text/plain").send("twilio not configured");
        }
      } else {
        // Unknown provider — no way to know what auth to send. Fall through
        // and let the upstream fetch surface its own 401/403.
      }
    }

    const upstream = await fetch(meta.blobUrl, { headers });
    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status || 502).type("text/plain").send("upstream fetch failed");
    }
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? meta.contentType);
    res.setHeader("Cache-Control", "public, max-age=300");
    // `attachment` (not `inline`) so WhatsApp treats it as a downloadable
    // file with the given name. Quote the filename to be safe.
    res.setHeader("Content-Disposition", `attachment; filename="${meta.filename.replace(/"/g, "")}"`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Readable } = await import("node:stream");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) {
    console.error("[media/fetch]", (err as Error).message);
    if (!res.headersSent) res.status(500).type("text/plain").send("error");
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Case-insensitive uniqueness check for library-scoped filenames within a
 * given folder. `null` folder_id is a real distinct value — treated as its
 * own "uncategorized" bucket. Passes an `excludeId` so a rename that
 * doesn't change the name (or a rename back to the same name for the same
 * row) doesn't self-collide.
 */
async function libraryNameTaken(
  db: DbExec,
  folderId: string | null,
  filename: string,
  excludeId: string | null,
): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM media_asset
    WHERE is_library = true
      AND deleted_at IS NULL
      AND lower(filename) = lower(${filename})
      AND (
        (${folderId === null} AND folder_id IS NULL)
        OR folder_id::text = ${folderId}
      )
      AND (${excludeId === null} OR id::text <> ${excludeId})
    LIMIT 1
  `);
  return (r.rowCount ?? 0) > 0;
}
