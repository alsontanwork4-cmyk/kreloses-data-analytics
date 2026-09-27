import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { lookupAccess } from "./access";
import { isApiPath, isPublicPath, loginPath } from "./paths";
import { SUPABASE_COOKIE_OPTIONS, sessionEmail, supabaseAuthConfig } from "./supabase-shared";

/**
 * The global gate, run by `src/proxy.ts` on every request except static assets:
 *
 * 1. Refreshes the Supabase session cookies (Server Components cannot write cookies).
 * 2. Public paths (`PUBLIC_PATHS`) pass through.
 * 3. Everything else needs a signed-in email that is on the allow-list:
 *    - anonymous: pages redirect to /login?next=…, API routes get 401
 *    - signed in but not allow-listed: signed out; pages redirect to /login?error=access-denied,
 *      API routes get 403
 *
 * Pages and route handlers still call `requireUser()` / `withUser()` themselves (defence in
 * depth, and to get the user's role) — never rely on this gate alone.
 */
export async function authGate(request: NextRequest): Promise<NextResponse> {
  const { url, publishableKey } = supabaseAuthConfig();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, publishableKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Must run before anything else: it refreshes an expired session and verifies the JWT.
  // Only magic-link sessions count (see src/auth/claims.ts).
  const email = await sessionEmail(supabase);

  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return response;

  const access = await lookupAccess(email);
  if (access.status === "allowed") return response;

  if (access.status === "denied") {
    await supabase.auth.signOut({ scope: "local" });
    if (isApiPath(pathname)) return withCookies(response, jsonResponse(403, "forbidden"));
    return withCookies(response, redirectTo(request, loginPath({ error: "access-denied" })));
  }

  if (isApiPath(pathname)) return withCookies(response, jsonResponse(401, "unauthenticated"));
  return withCookies(response, redirectTo(request, loginPath({ next: `${pathname}${search}` })));
}

function redirectTo(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

function jsonResponse(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Carries any session cookie changes (refresh or sign-out) over to a replacement response. */
function withCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  const cacheControl = from.headers.get("Cache-Control");
  if (cacheControl) to.headers.set("Cache-Control", cacheControl);
  return to;
}
