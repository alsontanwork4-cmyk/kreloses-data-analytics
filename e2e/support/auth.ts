import { expect, type Page } from "@playwright/test";

import { waitForMagicLink } from "./mailpit";

// Supabase Auth refuses a second link to the same email within `max_frequency` (1s locally).
const lastRequestAt = new Map<string, number>();
const MIN_INTERVAL_MS = 1_500;

/** Asks for a magic link on /login and returns the link from the mail catcher. */
export async function requestMagicLink(page: Page, email: string): Promise<string> {
  const wait = (lastRequestAt.get(email) ?? 0) + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);

  const since = new Date();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
  lastRequestAt.set(email, Date.now());
  return waitForMagicLink(email, since);
}

/** Signs in through the real magic-link flow and lands on the dashboard. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(await requestMagicLink(page, email));
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByTestId("signed-in-email").first()).toHaveText(email);
}
