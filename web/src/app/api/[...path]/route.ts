// The single entry point that replaced Express's `app.listen`.
//
// Every API request in the system lands here. Next's file-system router gives
// us the catch-all; server/app.ts owns the mount table and therefore all the
// authorization; server/http owns request parsing and response building.
//
// Deliberately ONE catch-all rather than a route.ts per path. The mount table
// is what enforces permissions — `app.use("/leads", readWriteDelete(…),
// leadsRouter)` guards 2,023 lines of handlers from a single line. Splitting
// into ~253 per-path files would mean re-attaching those guards by hand 253
// times, where one omission is an unauthenticated endpoint that throws no
// error and fails no test. Keeping the table intact removes that class of bug.

import { app } from "@/server/app";
import { ApiResponse, buildRequest, PayloadTooLargeError } from "@/server/http";
import { runWithTiming } from "@/server/lib/timing";

// pg, jose and LangGraph are all Node-only — this can never run on the edge.
export const runtime = "nodejs";
// Every request is user-specific and side-effecting; nothing here is cacheable.
export const dynamic = "force-dynamic";
// Agent runs stream a LangGraph graph and legitimately take tens of seconds.
// Requires Fluid compute on Vercel; the platform caps this at the plan limit.
export const maxDuration = 300;

async function handler(request: Request): Promise<Response> {
  let req;
  try {
    req = await buildRequest(request);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    if (err instanceof SyntaxError) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    throw err;
  }

  // Next mounts this file at /api/**, but the mount table is written in the
  // API's own terms (/leads, /webhooks/twilio, …) exactly as it was under
  // Express. Strip the prefix so those lines did not have to change.
  req.path = req.path.replace(/^\/api(?=\/|$)/, "") || "/";
  req.originalUrl = req.originalUrl.replace(/^\/api(?=\/|$)/, "") || "/";

  const res = new ApiResponse();

  const dispatch = async (): Promise<Response> => {
    try {
      return await app.handle(req, res);
    } catch (err) {
      // The JSON error envelope that used to be Express's final error
      // middleware. Same shape, same log prefix.
      console.error("[api]", err);
      if (res.headersSent) return res.done;
      return res.status(500).json({ error: (err as Error).message }).done;
    }
  };

  // Webhooks stay outside the timing wrapper, as they were under Express:
  // machine traffic, and we don't want Server-Timing on their responses.
  if (req.path.startsWith("/webhooks/")) return dispatch();
  return runWithTiming(req, res, dispatch);
}

export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as PUT,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
