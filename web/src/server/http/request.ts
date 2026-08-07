// Build an Express-shaped ApiRequest from a Web-standard Request.
//
// This replaces express.json() / express.urlencoded() from the old index.ts.
// Those were mounted per-prefix there (urlencoded for the Twilio and Exotel
// webhooks, json globally); parsing by Content-Type instead is equivalent and
// removes the ordering hazard that made the original mounts fragile.
//
// The raw bytes are always retained. Twilio's inbound webhook verifies an
// HMAC-SHA1 over the exact payload and cannot re-serialise from the parsed
// object, so `rawBody` has to survive parsing.

import type { ApiRequest } from "./types";

/** Matches the old `express.json({ limit: "6mb" })` outer guard. */
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 6 * 1024 * 1024);

export class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor() {
    super("Request body exceeds the 6mb limit");
    this.name = "PayloadTooLargeError";
  }
}

function parseQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return query;
}

function parseFormBody(raw: string): Record<string, string | string[]> {
  const params = new URLSearchParams(raw);
  const body: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    body[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return body;
}

export async function buildRequest(request: Request): Promise<ApiRequest> {
  const url = new URL(request.url);

  const headers: Record<string, string | undefined> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let body: unknown = {};
  let rawBody: Buffer | undefined;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.byteLength > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    rawBody = buf;

    const contentType = (headers["content-type"] ?? "").toLowerCase();
    const text = buf.toString("utf8");
    if (text.length === 0) {
      body = {};
    } else if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(text);
      } catch {
        // express.json() would surface a 400 here via its error handler. The
        // dispatcher turns this into the same 400.
        throw new SyntaxError("Invalid JSON body");
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      body = parseFormBody(text);
    } else {
      // Unknown content type — Express's json() leaves req.body as {}.
      body = {};
    }
  }

  // Vercel terminates TLS at the edge, so the inbound protocol is always http.
  // x-forwarded-proto carries what the client actually used, which is what the
  // signed-URL builder in media.ts needs.
  const protocol = headers["x-forwarded-proto"]?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");

  const get = (name: string): string | undefined => {
    const lower = name.toLowerCase();
    if (lower === "host") return headers["x-forwarded-host"] ?? headers["host"] ?? url.host;
    return headers[lower];
  };

  return {
    method: request.method.toUpperCase(),
    path: url.pathname,
    originalUrl: url.pathname + url.search,
    protocol,
    params: {},
    query: parseQuery(url),
    body,
    headers,
    rawBody,
    // No socket behind a serverless function — the three call sites that read
    // this already fall back to x-forwarded-for, which is the real client IP.
    socket: { remoteAddress: undefined },
    get,
    header: get,
  };
}
