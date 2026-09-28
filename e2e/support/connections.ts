import { expect, type Locator, type Page } from "@playwright/test";

/** Adds a Kreloses connection on the Connections page (as the signed-in owner); returns its card. */
export async function addConnection(page: Page, values: { label: string; email: string; password: string }): Promise<Locator> {
  await page.goto("/connections");
  await page.getByRole("button", { name: "Add connection" }).click();
  const form = page.getByRole("form", { name: "Add a Kreloses login" });
  await form.getByLabel("Name").fill(values.label);
  await form.getByLabel("Kreloses email").fill(values.email);
  await form.getByLabel("Kreloses password").fill(values.password);
  await form.getByRole("button", { name: "Save and test" }).click();
  await expect(form).toBeHidden();
  const card = page.getByRole("article", { name: values.label, exact: true });
  await expect(card.getByTestId("connection-status")).toHaveText("Connected");
  return card;
}

/** "Sync now" for one month on a connection card; waits until the sync has finished. */
export async function syncMonth(card: Locator, month: string) {
  await card.getByLabel("Month to sync").selectOption({ label: month });
  await card.getByRole("button", { name: "Sync now" }).click();
  await expect(card.getByRole("form", { name: "Sync sales" }).getByRole("button", { name: "Sync now" })).toBeEnabled({ timeout: 60_000 });
}
