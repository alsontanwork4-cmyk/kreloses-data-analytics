import { expect, type Page } from "@playwright/test";

import { emailIdsTo, waitForMagicLink } from "./mailpit";

// Supabase Auth refuses a second link to the same email within `max_frequency` (1s locally) with
// "For security purposes, you can only request this after N seconds". Any test (or a fresh
// Playwright worker, a --repeat-each round, a retry) can hit that, so wait and ask again.
const RATE_LIMITED = /For security purposes, you can only request this after/;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 1_100;

/** Asks for a magic link on /login and returns the link from the mail catcher. */
export async function requestMagicLink(page: Page, email: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const alreadySent = await emailIdsTo(email);
    const since = new Date();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    const sent = page.getByText("Check your email");
    const rateLimited = page.getByRole("alert").filter({ hasText: RATE_LIMITED });
    await expect(sent.or(rateLimited)).toBeVisible();
    if (await sent.isVisible()) return waitForMagicLink(email, since, { ignoreIds: alreadySent });

    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Supabase Auth still rate-limits sign-in links to ${email} after ${attempt} attempts`);
    }
    await page.waitForTimeout(RETRY_AFTER_MS);
  }
}

/** Signs in through the real magic-link flow and lands on the dashboard. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(await requestMagicLink(page, email));
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("signed-in-email").first()).toHaveText(email);
}
