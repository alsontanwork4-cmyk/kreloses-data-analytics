import "server-only";

import type { NextRequest } from "next/server";

import { getAccess } from "./session";
import { hasRole, type AppUser, type Role } from "./roles";

/**
 * Route Handler guards. Wrap EVERY route handler (except the explicitly public ones listed in
 * `PUBLIC_PATHS` / `PUBLIC_EXACT_PATHS`, which authenticate themselves):
 *
 *   export const GET = withUser(async (request, context, user) => Response.json({ email: user.email }));
 *   export const POST = withRole("owner", async (request, { params }, user) => { … });
 *
 * Anonymous → 401 `{ error: "unauthenticated" }`; signed in but not allow-listed, or missing the
 * role → 403 `{ error: "forbidden" }`.
 */
export type AuthedHandler<Context> = (
  request: NextRequest,
  context: Context,
  user: AppUser,
) => Response | Promise<Response>;

export function withUser<Context>(handler: AuthedHandler<Context>) {
  return guard<Context>(null, handler);
}

export function withRole<Context>(role: Role, handler: AuthedHandler<Context>) {
  return guard<Context>(role, handler);
}

function guard<Context>(role: Role | null, handler: AuthedHandler<Context>) {
  return async (request: NextRequest, context: Context): Promise<Response> => {
    const access = await getAccess();
    if (access.status === "anonymous") return jsonError(401, "unauthenticated");
    if (access.status === "denied") return jsonError(403, "forbidden");
    if (role && !hasRole(access.user, role)) return jsonError(403, "forbidden");
    return handler(request, context, access.user);
  };
}

export function jsonError(status: 401 | 403, error: "unauthenticated" | "forbidden"): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}
