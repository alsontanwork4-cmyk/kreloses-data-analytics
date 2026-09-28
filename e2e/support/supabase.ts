import { createServerClient } from "@supabase/ssr";
import { createClient, type Session } from "@supabase/supabase-js";
import type { BrowserContext } from "@playwright/test";

import { waitForMagicLink } from "./mailpit";

/**
 * Talks to the local Supabase Auth server directly, the way an attacker holding only the
 * publishable key could — used to prove the app refuses sessions that did not come from a
 * magic link.
 */
function authConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY missing (set them in .env.local)");
  return { url, key };
}

/**
 * A password session for `email`. Models the attack where someone registers a password for an
 * invited email before its owner ever signs in; the owner's first magic link then confirms the
 * account (simulated here by using the confirmation email), after which the password works.
 */
export async function passwordSession(email: string, appUrl: string): Promise<Session> {
  const { url, key } = authConfig();
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = `pw-${crypto.randomUUID()}`;
  const since = new Date();
  const signUp = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${appUrl}/auth/confirm` },
  });
  if (signUp.error) throw signUp.error;
  if (!signUp.data.session) {
    const link = await waitForMagicLink(email, since);
    const tokenHash = new URL(link).searchParams.get("token_hash");
    const confirmed = await client.auth.verifyOtp({ type: "email", token_hash: tokenHash! });
    if (confirmed.error) throw confirmed.error;
  }
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw signIn.error;
  return signIn.data.session;
}

/** Puts `session` into the browser the same way the app stores it (the @supabase/ssr cookies). */
export async function useSessionInBrowser(context: BrowserContext, session: Session, appUrl: string) {
  const { url, key } = authConfig();
  const jar = new Map<string, string>();
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession(session);
  if (error) throw error;
  await context.addCookies([...jar].map(([name, value]) => ({ name, value, url: appUrl })));
}
