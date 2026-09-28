import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { SUPABASE_COOKIE_OPTIONS, supabaseAuthConfig } from "./supabase-shared";

export { sessionEmail } from "./supabase-shared";

/**
 * Supabase JS is used for Auth only (magic links + session cookies). App data goes through
 * `getDb()` (direct Postgres), never through the Supabase Data API.
 *
 * Supabase Auth client bound to the request's cookies, for Server Components, Server Actions and
 * Route Handlers. Create one per request. Server Components cannot write cookies, so session
 * refreshes there are ignored; the proxy (`src/proxy.ts`) refreshes the session on every request.
 */
export async function createSupabaseServerClient() {
  // Read cookies first: it marks the route dynamic, so builds never evaluate the config below.
  const cookieStore = await cookies();
  const { url, publishableKey } = supabaseAuthConfig();
  return createServerClient(url, publishableKey, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy already refreshed the session.
        }
      },
    },
  });
}

/**
 * A Supabase Auth client with no cookies: it never reads or writes the current request's session.
 * For acting on behalf of someone else, e.g. emailing an invited manager their sign-in link.
 */
export function createDetachedSupabaseClient() {
  const { url, publishableKey } = supabaseAuthConfig();
  return createServerClient(url, publishableKey, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
