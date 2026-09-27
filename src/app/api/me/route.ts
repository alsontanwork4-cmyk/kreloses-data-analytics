import { withUser } from "@/auth/api";

/** The signed-in user's email and role (401 anonymous, 403 not on the allow-list). */
export const GET = withUser(async (_request, _context, user) =>
  Response.json({ email: user.email, role: user.role }, { headers: { "Cache-Control": "no-store" } }),
);
