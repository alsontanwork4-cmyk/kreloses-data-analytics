"use server";

import { cookies } from "next/headers";

import { lookupAccess } from "@/auth/access";
import { isValidEmail, normaliseEmail } from "@/auth/allow-list";
import { requestOrigin, sendSignInLink } from "@/auth/magic-link";
import { NEXT_PATH_COOKIE } from "@/auth/next-path-cookie";
import { LOGIN_ERROR_MESSAGES, safeNextPath } from "@/auth/paths";
import { createSupabaseServerClient } from "@/auth/supabase";

export type MagicLinkState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string; email: string };

/**
 * Sends a magic link, but only to allow-listed emails: anyone else is refused before Supabase is
 * asked to send anything. Public by design (it is how you sign in).
 */
export async function requestMagicLink(
  _previous: MagicLinkState,
  formData: FormData,
): Promise<MagicLinkState> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  if (!isValidEmail(email)) {
    return { status: "error", email, message: "Enter a valid email address." };
  }

  const access = await lookupAccess(email);
  if (access.status !== "allowed") {
    return { status: "error", email, message: LOGIN_ERROR_MESSAGES["not-invited"] };
  }

  // The cookie-bound client, so the PKCE fallback (`?code=`) keeps its verifier in this browser.
  const origin = await requestOrigin();
  const sent = await sendSignInLink(await createSupabaseServerClient(), email, origin);
  if (!sent.ok) {
    return { status: "error", email, message: `Could not send the sign-in link: ${sent.message}` };
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
