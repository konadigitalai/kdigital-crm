// Router — a drop-in replacement for `express.Router()`.
//
// Route files import this instead of Express and are otherwise untouched:
//   -import { Router } from "express";
//   +import { Router } from "@/server/http";
//
// Only the five verbs the codebase uses are exposed (get/post/patch/put/
// delete). Path patterns across all 48 routers are literal segments and
// `:params` only — no regex, no wildcards, no nested `router.use` — so the
// matcher below covers the entire surface.
//
// Express defaults are reproduced deliberately, because changing them would
// silently change which requests 404:
//   • case-insensitive matching  (Express `case sensitive routing` is off)
//   • optional trailing slash    (Express `strict routing` is off)
//   • first registered match wins

import type { Handler } from "./types";

export interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  /**
   * The handler chain. 80+ registrations across the routers attach a guard
   * inline — `router.get("/runs", requirePermission("agents.read"), handler)` —
   * and those guards are as load-bearing as the mount-table ones, so a route
   * is a chain rather than a single function.
   */
  handlers: Handler[];
}

/** Compile `/leads/:id/notes` into a regex plus its ordered param names. */
export function compilePath(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "/([^/]+)";
      }
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    })
    .join("");
  // `(?:/)?` is the non-strict trailing slash; `^…$` anchors the whole path.
  return { regex: new RegExp(`^${source || "/"}(?:/)?$`, "i"), keys };
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape shouldn't 500 the request; hand the raw value over
    // and let the handler's own validation reject it.
    return value;
  }
}

export class RouteRegistry {
  readonly routes: Route[] = [];

  private add(method: string, pattern: string, handlers: Handler[]): this {
    const { regex, keys } = compilePath(pattern);
    this.routes.push({ method, pattern, regex, keys, handlers });
    return this;
  }

  get(pattern: string, ...handlers: Handler[]): this {
    return this.add("GET", pattern, handlers);
  }
  post(pattern: string, ...handlers: Handler[]): this {
    return this.add("POST", pattern, handlers);
  }
  patch(pattern: string, ...handlers: Handler[]): this {
    return this.add("PATCH", pattern, handlers);
  }
  put(pattern: string, ...handlers: Handler[]): this {
    return this.add("PUT", pattern, handlers);
  }
  delete(pattern: string, ...handlers: Handler[]): this {
    return this.add("DELETE", pattern, handlers);
  }

  /**
   * First route matching both verb and path, with its params extracted.
   * Returns null when nothing matches, which the dispatcher treats as
   * "fall through to the next mount" — the behaviour that lets `/leads` be
   * served by leadsRouter and convertRouter in sequence.
   */
  match(method: string, path: string): { handlers: Handler[]; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        const raw = m[i + 1];
        if (raw !== undefined) params[key] = decodeParam(raw);
      });
      return { handlers: route.handlers, params };
    }
    return null;
  }

  /** True when any route matches the path regardless of verb (→ 405 vs 404). */
  matchesPath(path: string): boolean {
    return this.routes.some((route) => route.regex.test(path));
  }
}

/**
 * Factory mirroring `express.Router()` — callable without `new`, which is how
 * every route file already writes it (`export const leadsRouter = Router()`).
 * The companion type alias lets `Router` keep working in type position too.
 */
export function Router(): RouteRegistry {
  return new RouteRegistry();
}
export type Router = RouteRegistry;
