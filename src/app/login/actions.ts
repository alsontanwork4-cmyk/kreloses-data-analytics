"use server";

import { cookies, headers } from "next/headers";

import { lookupAccess } from "@/auth/access";
import { normaliseEmail } from "@/auth/allow-list";
import { NEXT_PATH_COOKIE } from "@/auth/next-path-cookie";
import { LOGIN_ERROR_MESSAGES, safeNextPath } from "@/auth/paths";
import { createSupabaseServerClient } from "@/auth/supabase";

export type MagicLinkState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string; email: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends a magic link, but only to allow-listed emails: anyone else is refused before Supabase is
 * asked to send anything. Public by design (it is how you sign in).
 */
export async function requestMagicLink(
  _previous: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  if (!EMAIL.test(email)) {
    return { status: "error", email, message: "Enter a valid email address." };
  }

  const access = await lookupAccess(email);
  if (access.status !== "allowed") {
    return { status: "error", email, message: LOGIN_ERROR_MESSAGES["not-invited"] };
  }

  const requestHeaders = await headers();
  const origin =
    requestHeaders.get("origin") ??
    `${requestHeaders.get("x-forwarded-proto") ?? "http"}://${requestHeaders.get("host")}`;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    // The email template appends ?token_hash=…&type=email to this URL (see supabase/templates).
    options: { emailRedirectTo: `${origin}/auth/confirm`, shouldCreateUser: true },
  });
  if (error) {
    return { status: "error", email, message: `Could not send the sign-in link: ${error.message}` };
  }

  const next = safeNextPath(formData.get("next"));
  const cookieStore = await cookies();
  if (next) {
    cookieStore.set(NEXT_PATH_COOKIE, next, {
      httpOnly: true,
      sameSite: "lax",
      secure: origin.startsWith("https://"),
      path: "/",
      maxAge: 60 * 60,
    });
  } else {
    cookieStore.delete(NEXT_PATH_COOKIE);
  }
  return { status: "sent", email };
}
