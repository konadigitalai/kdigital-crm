// App — reproduces the subset of Express's application/layer semantics that
// the old api/src/index.ts mount table depends on.
//
// This is the piece that makes the migration behaviour-preserving. The mount
// table is what enforces authorization:
//
//   app.use("/leads", readWriteDelete("leads.read","leads.write","leads.delete"), leadsRouter)
//
// One line guards every handler in a 2,023-line router. Porting each handler
// to its own file would have meant re-attaching that guard ~253 times, where a
// single omission is an unauthenticated endpoint with no error and no failing
// test. Keeping the mount table intact removes that failure mode entirely.
//
// Semantics reproduced, all of them load-bearing:
//   • Layers run in registration order.
//   • `app.use(mw)` with no path applies to every layer registered after it —
//     this is what makes `app.use(authMiddleware)` split public from private.
//   • A router that matches the path prefix but has no matching route falls
//     THROUGH to the next layer. `/leads` (leadsRouter, then convertRouter)
//     and `/batches` (batchesRouter, then batchBoardRouter) both rely on this.
//   • Prefix matching is on segment boundaries: `/leads` does not match
//     `/leadsxyz`.

import { ApiResponse } from "./response";
import { compilePath, type RouteRegistry } from "./router";
import type { ApiRequest, Handler, NextFunction } from "./types";

type Layer =
  | { kind: "middleware"; prefix: string; handler: Handler }
  | { kind: "router"; prefix: string; guards: Handler[]; router: RouteRegistry }
  | { kind: "route"; method: string; regex: RegExp; keys: string[]; handler: Handler };

function isRouter(value: unknown): value is RouteRegistry {
  return typeof value === "object" && value !== null && Array.isArray((value as RouteRegistry).routes);
}

/** Normalise a mount prefix to `/foo` with no trailing slash (`/` stays `/`). */
function normalisePrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/**
 * Match a mount prefix against a path on a segment boundary, returning the
 * remainder the mounted router should see (`/leads/42` under `/leads` → `/42`,
 * `/leads` under `/leads` → `/`). Returns null when the prefix doesn't apply.
 */
function stripPrefix(prefix: string, path: string): string | null {
  if (prefix === "/") return path;
  const lowerPath = path.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerPath.startsWith(lowerPrefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return "/";
  if (!rest.startsWith("/")) return null; // `/leadsxyz` must not match `/leads`
  return rest;
}

export class App {
  private readonly layers: Layer[] = [];

  /** `app.use(handler)`, `app.use(path, ...handlers)`, `app.use(path, router)`. */
  use(pathOrHandler: string | Handler | RouteRegistry, ...rest: Array<Handler | RouteRegistry>): this {
    const hasPath = typeof pathOrHandler === "string";
    const prefix = hasPath ? normalisePrefix(pathOrHandler) : "/";
    const chain = hasPath ? rest : [pathOrHandler as Handler | RouteRegistry, ...rest];

    const last = chain[chain.length - 1];
    if (isRouter(last)) {
      this.layers.push({
        kind: "router",
        prefix,
        guards: chain.slice(0, -1) as Handler[],
        router: last,
      });
    } else {
      for (const handler of chain) {
        this.layers.push({ kind: "middleware", prefix, handler: handler as Handler });
      }
    }
    return this;
  }

  /** `app.get("/health", …)` — a route registered directly on the app. */
  get(pattern: string, handler: Handler): this {
    const { regex, keys } = compilePath(pattern);
    this.layers.push({ kind: "route", method: "GET", regex, keys, handler });
    return this;
  }

  /**
   * Run one handler. Returns "settled" if it produced a response, "next" if it
   * delegated onward. Throws whatever it threw or passed to `next(err)`.
   */
  private static async runHandler(handler: Handler, req: ApiRequest, res: ApiResponse): Promise<"settled" | "next"> {
    let nextCalled = false;
    let nextError: unknown;
    let hasError = false;

    const next: NextFunction = (err?: unknown) => {
      if (err !== undefined && err !== null) {
        hasError = true;
        nextError = err;
      } else {
        nextCalled = true;
      }
    };

    await handler(req, res, next);

    if (hasError) throw nextError;
    if (res.headersSent) return "settled";
    if (nextCalled) return "next";
    // Handler returned without responding and without delegating. In Express
    // this hangs the request; falling through to the 404 is strictly better.
    return "next";
  }

  async handle(req: ApiRequest, res: ApiResponse): Promise<Response> {
    const fullPath = req.path;

    for (const layer of this.layers) {
      if (layer.kind === "route") {
        if (layer.method !== req.method) continue;
        const m = layer.regex.exec(fullPath);
        if (!m) continue;
        const params: Record<string, string> = {};
        layer.keys.forEach((key, i) => {
          const raw = m[i + 1];
          if (raw !== undefined) params[key] = raw;
        });
        req.params = params;
        req.path = fullPath;
        const outcome = await App.runHandler(layer.handler, req, res);
        if (outcome === "settled") return res.done;
        continue;
      }

      const rest = stripPrefix(layer.prefix, fullPath);
      if (rest === null) continue;

      if (layer.kind === "middleware") {
        req.path = rest;
        const outcome = await App.runHandler(layer.handler, req, res);
        if (outcome === "settled") return res.done;
        continue;
      }

      // Router layer. Guards run whenever the prefix matches — exactly as
      // Express does — so a 403 still fires on a path the router itself
      // doesn't serve.
      req.path = rest;
      let rejected = false;
      for (const guard of layer.guards) {
        const outcome = await App.runHandler(guard, req, res);
        if (outcome === "settled") {
          rejected = true;
          break;
        }
      }
      if (rejected) return res.done;

      const matched = layer.router.match(req.method, rest);
      if (!matched) continue; // fall through to the next mount on this prefix

      req.params = matched.params;
      // Run the route's own chain. Inline guards
      // (`router.get(p, requirePermission(…), handler)`) live here, so a
      // handler is only reached once every guard before it called next().
      let settled = false;
      for (const handler of matched.handlers) {
        const outcome = await App.runHandler(handler, req, res);
        if (outcome === "settled") {
          settled = true;
          break;
        }
      }
      if (settled) return res.done;
    }

    req.path = fullPath;
    return res.status(404).json({ error: "Not found" }).done;
  }
}

export function createApp(): App {
  return new App();
}
