/**
 * The only sign-in method this app accepts is an emailed magic link. Supabase Auth also allows
 * password sign-ups, OAuth and more through its public API, so the session's `amr` claim
 * (authentication methods) must show an email link, not just any verified email.
 *
 * Observed from Supabase Auth: our token-hash link (`verifyOtp`) → `otp`; the PKCE `?code=`
 * fallback → `magiclink`; password sign-up/sign-in → `password`. `amr` survives token refreshes.
 */
const EMAIL_LINK_METHODS = new Set(["otp", "magiclink"]);

/** The email from verified JWT claims, or null unless the session came from a magic link. */
export function magicLinkEmail(claims: unknown): string | null {
  if (!claims || typeof claims !== "object") return null;
  const { email, amr } = claims as { email?: unknown; amr?: unknown };
  if (typeof email !== "string" || email === "" || !Array.isArray(amr)) return null;
  const viaEmailLink = amr.some(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      EMAIL_LINK_METHODS.has((entry as { method?: unknown }).method as string),
  );
  return viaEmailLink ? email : null;
}
