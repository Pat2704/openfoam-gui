/**
 * Refuse API calls that another web page made on the user's behalf.
 *
 * THE PROBLEM
 * -----------
 * The app is a web page talking to REST routes on 127.0.0.1, and a browser will
 * happily let ANY site send requests to 127.0.0.1. Same-origin policy stops the
 * attacker READING the answer; it does not stop the request from being made, and
 * several of these routes do their damage on the way in rather than on the way
 * out:
 *
 *     <img src="http://127.0.0.1:49731/api/wsl?action=killAll">
 *
 * is enough to kill every running solver, from a page that never sees a byte of
 * the response. `?action=kill&pid=…` and `?action=setFoamVersion&bashrc=…` are
 * the same shape. POST is barely harder: a form or a `fetch` with a text/plain
 * body is a "simple request", so it is sent without a preflight, and the route
 * parses the body regardless of its Content-Type.
 *
 * The port is random per launch, which is a speed bump and not a defence — a
 * page can work through the ephemeral range in the background.
 *
 * THE CHECK
 * ---------
 * `Sec-Fetch-Site` is set by the browser itself and cannot be forged by page
 * script. `same-origin` is the app's own fetches; `none` is a user-initiated
 * navigation. Anything the browser labels `cross-site` or `same-site` was
 * started by a different origin, and no legitimate caller of this API is in that
 * position.
 *
 * A request with NO Sec-Fetch-Site at all is allowed through, deliberately: that
 * is a non-browser client, which here means the agent's MCP bridge (a Node
 * process spawned by this server) and the health checks used when verifying a
 * packaged build. Those cannot be driven by a web page — a page cannot suppress
 * the header — and /api/agent/tools is separately behind the agent token. The
 * check is aimed exactly at the attack it can see, and does not pretend to be
 * authentication.
 */

/*
 * WHY `proxy.ts` AND NOT `middleware.ts`
 * --------------------------------------
 * The `middleware` file convention is DEPRECATED in Next.js 16 and renamed to
 * `proxy` — same behaviour, different file name and different export name (see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
 * and note AGENTS.md's warning that this is not the Next.js you remember). A
 * `middleware.ts` still builds today, which is exactly what makes it worth
 * getting right now rather than discovering it on the next upgrade.
 */

import { NextResponse, type NextRequest } from 'next/server';

export const config = { matcher: '/api/:path*' };

/** Labels a browser applies to a request that some OTHER origin initiated. */
const CROSS_ORIGIN = new Set(['cross-site', 'same-site']);

export function proxy(req: NextRequest) {
  const site = req.headers.get('sec-fetch-site');
  if (site && CROSS_ORIGIN.has(site)) {
    return NextResponse.json(
      { error: 'This endpoint only answers the application itself.' },
      { status: 403 },
    );
  }
  return NextResponse.next();
}
