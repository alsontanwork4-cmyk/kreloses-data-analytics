import "server-only";

import { getDb } from "@/db/client";

import { checkAccess, upsertOwner, type Access } from "./allow-list";

let ownerSeed: Promise<void> | undefined;

/**
 * Makes sure `OWNER_EMAIL` is on the allow-list as an owner. Runs once per server process, the
 * first time access is checked, so a fresh production database needs no manual seeding.
 */
function ensureOwnerFromEnv(): Promise<void> {
  const ownerEmail = process.env.OWNER_EMAIL?.trim();
  if (!ownerEmail) return Promise.resolve();
  ownerSeed ??= upsertOwner(getDb(), ownerEmail).then(
    () => undefined,
    (error: unknown) => {
      ownerSeed = undefined; // retry on the next request
      throw error;
    },
  );
  return ownerSeed;
}

/** Access decision for an authenticated email (or null) against the app database. */
export async function lookupAccess(email: string | null): Promise<Access> {
  if (!email) return { status: "anonymous" }; // no database work for anonymous traffic
  await ensureOwnerFromEnv();
  return checkAccess(getDb(), email);
}
