// Thin wrapper around @vercel/blob. Keeps the rest of the codebase from
// importing the SDK directly, so if we ever swap storage backends (S3, R2)
// the surface area is one file.
//
// Two flows worth understanding:
//
//   1. Direct-browser-to-Blob uploads. The FE calls @vercel/blob/client's
//      `upload(...)` which needs a client-token. That client-token is minted
//      by `handleUploadRequest()` below — we bind it to a specific pathname
//      + content-type + max-size, so a token can only be used to store one
//      file at one location. Vercel then calls `onUploadCompleted` back into
//      our API, at which point we INSERT the media_asset row.
//
//   2. Server-side delete. When a user (or the future GC cron) removes an
//      asset, `deleteBlob()` calls the SDK to actually free the bytes.
//
// One env var: BLOB_READ_WRITE_TOKEN. Read on first use, not at module
// import — lets tests / preflight run without it.

import { del } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export class BlobNotConfigured extends Error {
  constructor() {
    super("BLOB_READ_WRITE_TOKEN is not set. Media uploads/deletes will fail.");
    this.name = "BlobNotConfigured";
  }
}

function readBlobToken(): string {
  const t = (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim();
  if (!t) throw new BlobNotConfigured();
  return t;
}

// ─── Handle upload request ────────────────────────────────────────────────
//
// The FE POSTs to our `/media/upload-token` endpoint TWICE per upload:
//
//   Call 1 — { type: "blob.generate-client-token" }:
//     We validate the request, build a per-upload token, and return it.
//
//   Call 2 — { type: "blob.upload-completed", blob: {…} }:
//     Vercel calls us AFTER the browser finished PUTting to Blob. We
//     persist the media_asset row here. Vercel expects HTTP 200 for
//     us to consider the upload durable.
//
// Both calls go through this same wrapper. Callers supply:
//   - authorizePathname: (pathname, clientPayload) → {tenantId, uploadedBy, folderId, isLibrary, maxSizeBytes, allowedContentTypes}
//   - persistAsset:      (details) → void  (runs on the completion callback)

export interface AuthorizedUpload {
  tenantId: string;
  uploadedBy: string;
  folderId: string | null;
  isLibrary: boolean;
  maxSizeBytes: number;
  allowedContentTypes: string[];
}

export interface CompletedUpload {
  blobUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string | null;
  size: number | null;    // Vercel returns size in the blob object when known
  clientPayload: string | null;
}

export interface HandleUploadArgs {
  body: HandleUploadBody;
  request: Request;
  authorize: (pathname: string, clientPayload: string | null) => Promise<AuthorizedUpload>;
  onCompleted: (details: CompletedUpload, authorized: AuthorizedUpload) => Promise<void>;
}

/**
 * Wraps @vercel/blob's `handleUpload` and threads our own authorize/persist
 * hooks through it. Returns whatever handleUpload returns (the client-token
 * JSON or the upload-completed ack) — caller just JSON-serialises.
 */
export async function handleBlobUpload(args: HandleUploadArgs): Promise<unknown> {
  const token = readBlobToken();
  // The authorize hook fires on the token-generation call. We stash the
  // resolved authorization so the onUploadCompleted hook (a separate HTTP
  // call, no closure) can pull it back out of the clientPayload JSON.
  //
  // The clientPayload is a caller-controlled string that Vercel round-trips
  // between the two calls. We put a signed JSON in there.
  return await handleUpload({
    token,
    request: args.request,
    body: args.body,
    onBeforeGenerateToken: async (pathname, clientPayload) => {
      const authz = await args.authorize(pathname, clientPayload);
      return {
        allowedContentTypes: authz.allowedContentTypes,
        maximumSizeInBytes: authz.maxSizeBytes,
        // Add a random suffix so re-uploads of the same-name file don't
        // collide in Blob storage. Original filename is preserved in the
        // media_asset row separately.
        addRandomSuffix: true,
        // Re-emit the authz context in the token payload; the completion
        // callback below can rehydrate it.
        tokenPayload: JSON.stringify({
          tenantId: authz.tenantId,
          uploadedBy: authz.uploadedBy,
          folderId: authz.folderId,
          isLibrary: authz.isLibrary,
        }),
      };
    },
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      // Rehydrate the authorization stashed in tokenPayload.
      let parsed: {
        tenantId: string;
        uploadedBy: string;
        folderId: string | null;
        isLibrary: boolean;
      };
      try {
        parsed = JSON.parse(tokenPayload ?? "{}");
      } catch {
        throw new Error("upload-completed: malformed tokenPayload");
      }
      // Re-package as the AuthorizedUpload shape callers expect. Rebuild
      // maxSizeBytes + allowedContentTypes from an empty shell — the
      // enforcement already happened at token-generation time; we don't
      // need them again.
      const authz: AuthorizedUpload = {
        tenantId: parsed.tenantId,
        uploadedBy: parsed.uploadedBy,
        folderId: parsed.folderId,
        isLibrary: parsed.isLibrary,
        maxSizeBytes: 0,
        allowedContentTypes: [],
      };
      await args.onCompleted({
        blobUrl: blob.url,
        pathname: blob.pathname,
        contentType: blob.contentType,
        contentDisposition: blob.contentDisposition ?? null,
        size: null,
        clientPayload: tokenPayload ?? null,
      }, authz);
    },
  });
}

// ─── Delete ───────────────────────────────────────────────────────────────

export async function deleteBlob(pathnameOrUrl: string): Promise<void> {
  const token = readBlobToken();
  await del(pathnameOrUrl, { token });
}

// ─── Path helpers ─────────────────────────────────────────────────────────

/**
 * Namespace uploads under tenant so cross-tenant collisions are impossible.
 * The random suffix keeps two-users-uploading-same-filename separate.
 */
export function tenantPathname(tenantId: string, filename: string): string {
  const safe = filename
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  const suffix = randomToken(8);
  return `tenants/${tenantId}/${suffix}-${safe || "file"}`;
}

function randomToken(bytes: number): string {
  // Node 20 exposes `crypto.getRandomValues` on globalThis unconditionally.
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
