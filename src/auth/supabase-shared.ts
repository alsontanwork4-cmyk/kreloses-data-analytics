import type { CookieOptionsWithName } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { magicLinkEmail } from "./claims";

/** Shared by the request-scoped client (`./supabase`) and the proxy gate. */
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

/** Auth cookies are only ever read on the server (there is no browser Supabase client). */
export const SUPABASE_COOKIE_OPTIONS: CookieOptionsWithName = { httpOnly: true, sameSite: "lax", path: "/" };

/**
 * The signed-in email, verified: `getClaims()` checks the JWT (never trust `getSession()` alone)
 * and the session must come from a magic link (see `magicLinkEmail`). Null otherwise.
 */
export async function sessionEmail(supabase: Pick<SupabaseClient, "auth">): Promise<string | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  return magicLinkEmail(data.claims);
}
