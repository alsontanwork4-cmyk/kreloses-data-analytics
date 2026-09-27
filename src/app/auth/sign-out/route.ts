import { NextResponse, type NextRequest } from "next/server";

import { LOGIN_PATH } from "@/auth/paths";
import { createSupabaseServerClient } from "@/auth/supabase";

/** POST-only sign out (public: anyone may end their own session). */
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL(LOGIN_PATH, request.url), { status: 303 });
}
