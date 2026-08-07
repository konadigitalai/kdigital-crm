// Shared shapes for the Express-compatible HTTP layer.
//
// These mirror the subset of Express's Request/Response that this codebase
// actually uses — verified by inventory across all 48 routers:
//   res: status, json, send, setHeader, header, type, redirect, sendStatus, end
//   req: params, query, body, headers, method, path, originalUrl, protocol,
//        get/header, socket.remoteAddress, rawBody
// Nothing else is provided, deliberately: if a future handler reaches for a
// real Express API that isn't here, it fails at compile time rather than at
// runtime in production.

export interface AuthedUser {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
}

import type { ApiResponse } from "./response";

export interface ApiRequest {
  /** Uppercase HTTP verb. */
  method: string;
  /**
   * Path relative to the current mount point, mirroring Express's `req.path`.
   * Under `app.use("/leads", …)`, a request for `/leads/42` sees `/42`.
   */
  path: string;
  /** Full request path including the mount prefix and querystring. */
  originalUrl: string;
  protocol: string;
  params: Record<string, string>;
  /**
   * Express types this as `any` too (ParsedQs is assignable to anything the
   * handlers do with it). Handlers routinely write `req.query.limit as string`
   * or pass values straight into a zod parse, so a narrower type here would
   * mean touching hundreds of call sites for no safety gain — the values are
   * validated at use, not at read.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any;
  /**
   * `any`, matching Express's own `Request["body"]`. This is what the 163
   * `req.body` call sites were written against: they destructure it directly
   * and validate with zod inside the handler. Typing it `unknown` produced
   * ~1,500 compile errors that were all "you must validate this first" — which
   * the handlers already do.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string | undefined>;
  /**
   * Raw request body, before parsing. Twilio's inbound webhook verifies an
   * HMAC-SHA1 over the exact bytes, so it cannot re-serialise from `body`.
   */
  rawBody?: Buffer;
  /**
   * Present so the three `req.socket.remoteAddress` call sites keep compiling.
   * There is no socket behind a serverless function, so `remoteAddress` is
   * always undefined and those call sites fall through to x-forwarded-for,
   * which is what actually carries the client IP on Vercel.
   */
  socket: { remoteAddress?: string };
  get(name: string): string | undefined;
  header(name: string): string | undefined;

  // ── Injected by requireAuth (was authMiddleware) ────────────────────────
  tenantId?: string;
  userId?: string;
  user?: AuthedUser;
  permissions?: Set<string>;
}

/** Terminal `res` methods resolve the response; `next(err)` rejects it. */
export type NextFunction = (err?: unknown) => void;

export type Handler = (
  req: ApiRequest,
  res: ApiResponse,
  next: NextFunction,
) => void | Promise<void> | unknown;

// Re-exported so callers can pull the whole request/response vocabulary from
// one module.
export type { ApiResponse };
