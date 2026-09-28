import type { EmailOtpType } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { recordSignIn } from "@/auth/allow-list";
import { NEXT_PATH_COOKIE } from "@/auth/next-path-cookie";
import { HOME_PATH, loginPath, safeNextPath } from "@/auth/paths";
import { createSupabaseServerClient } from "@/auth/supabase";
import { getDb } from "@/db/client";

const OTP_TYPES: readonly EmailOtpType[] = ["email", "magiclink", "signup"];

/**
 * Where the magic link lands (public). Our email template sends `?token_hash=…&type=email`,
 * which works on any device. `?code=…` (PKCE, same browser only) is accepted too, in case a
 * hosted project still uses Supabase's default email template.
 *
 * This only establishes the Supabase session (and notes the sign-in time for Settings → Users);
 * the allow-list is enforced on the next request.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const code = params.get("code");

  const supabase = await createSupabaseServerClient();
  let signedIn: { email?: string } | null = null;
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) signedIn = { email: data.user?.email };
  } else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) signedIn = { email: data.user?.email };
  }
  if (!signedIn) redirect(loginPath({ error: "link-invalid" }));

  if (signedIn.email) {
    try {
      await recordSignIn(getDb(), signedIn.email);
    } catch (error) {
      // Only feeds "last sign-in" on Settings → Users; never block signing in over it.
      console.error("Could not record the sign-in time", error);
    }
  }

  const cookieStore = await cookies();
  const next = safeNextPath(cookieStore.get(NEXT_PATH_COOKIE)?.value) ?? HOME_PATH;
  cookieStore.delete(NEXT_PATH_COOKIE);
  redirect(next);
}
