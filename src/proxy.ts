import type { NextRequest } from "next/server";

import { authGate } from "@/auth/proxy-gate";

export function proxy(request: NextRequest) {
  return authGate(request);
}

export const config = {
  // Everything except Next.js internals and static files. Keep auth on by default: new pages
  // and API routes are protected without touching this file (public ones go in PUBLIC_PATHS).
  matcher: [
    "/((?!_next/static|_next/image|__nextjs|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
};
