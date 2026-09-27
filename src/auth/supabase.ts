import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase JS is used for Auth only (magic links + session cookies). App data goes through
 * `getDb()` (direct Postgres), never through the Supabase Data API.
 */
export function supabaseAuthConfig(): { url: string; publishableKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set (see .env.example).",
    );
  }
  return { url, publishableKey };
}

/**
 * Supabase Auth client bound to the request's cookies, for Server Components, Server Actions and
 * Route Handlers. Create one per request. Server Components cannot write cookies, so session
 * refreshes there are ignored; the proxy (`src/proxy.ts`) refreshes the session on every request.
 */
export async function createSupabaseServerClient() {
  const { url, publishableKey } = supabaseAuthConfig();
  const cookieStore = await cookies();
  return createServerClient(url, publishableKey, {
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

/** The verified email of the signed-in Supabase user, or null. Verifies the JWT (never trusts getSession alone). */
export async function verifiedEmail(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  return typeof data.claims.email === "string" && data.claims.email ? data.claims.email : null;
}
