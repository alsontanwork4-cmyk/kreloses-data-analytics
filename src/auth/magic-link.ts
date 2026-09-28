import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";

import type { SignInLinkResult, SignInLinkSender } from "./managers";
import { createDetachedSupabaseClient } from "./supabase";

/**
 * The one way the app emails a sign-in link (magic link): the login page uses it for the person
 * signing in, Settings → Users for a manager being invited. The link lands on `/auth/confirm`
 * (see `supabase/templates/magic_link.html`). Callers decide who may receive a link: the login
 * page only sends to allow-listed emails, and an invite adds the email to the allow-list first.
 */
export async function sendSignInLink(
  supabase: Pick<SupabaseClient, "auth">,
  email: string,
  origin: string,
): Promise<SignInLinkResult> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    // The email template appends ?token_hash=…&type=email to this URL (see supabase/templates).
    options: { emailRedirectTo: `${origin}/auth/confirm`, shouldCreateUser: true },
  });
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** This app's origin (scheme + host) as seen by the current request, for links in emails. */
export async function requestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get("origin") ??
    `${requestHeaders.get("x-forwarded-proto") ?? "http"}://${requestHeaders.get("host")}`
  );
}

/**
 * Sends sign-in links to someone other than the signed-in user (an invite). Uses a Supabase client
 * that is not bound to the request's cookies, so the owner's own session cookies are never touched
 * (with the cookie-bound client, Supabase would store the invitee's PKCE verifier in the owner's
 * browser).
 */
export async function signInLinkSenderForInvites(): Promise<SignInLinkSender> {
  const origin = await requestOrigin();
  const supabase = createDetachedSupabaseClient();
  return (email) => sendSignInLink(supabase, email, origin);
}
