import { expect, test } from "@playwright/test";

import { NAV_ITEMS } from "../src/components/shell/nav-config";
import { formatDateRange, resolveDatePreset } from "../src/filters";

import { signIn } from "./support/auth";
import { run } from "./support/run";

test.describe("dashboard shell", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, run.ownerEmail);
  });

  test("every nav page renders in the shell; analytics pages show an empty state", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const item of NAV_ITEMS) {
      await nav.getByRole("link", { name: item.label, exact: true }).click();
      // A section such as Settings may open one of its sub-pages.
      await expect(page).toHaveURL((url) => url.pathname === item.href || url.pathname.startsWith(`${item.href}/`));
      await expect(page.getByRole("heading", { level: 1, name: item.label })).toBeVisible();
      if (item.section === "analytics") await expect(page.getByTestId("empty-state")).toBeVisible();
      await expect(nav.getByRole("link", { name: item.label, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      const hasFilters = item.section === "analytics";
      await expect(page.getByRole("region", { name: "Filters" })).toHaveCount(hasFilters ? 1 : 0);
    }
  });

  test("the filter bar keeps its state in the URL", async ({ page }) => {
    const filters = page.getByRole("region", { name: "Filters" });
    const range = page.getByTestId("filter-range");

    // Default: month to date.
    const mtd = resolveDatePreset("month-to-date");
    await expect(filters.getByRole("link", { name: "Month to date" })).toHaveAttribute("aria-current", "true");
    await expect(range).toHaveText(formatDateRange(mtd.dateFrom, mtd.dateTo));

    // Every preset is one click and lands in the URL.
    for (const [label, preset] of [
      ["Today", "today"],
      ["This week", "this-week"],
      ["Last month", "last-month"],
      ["Year to date", "year-to-date"],
    ] as const) {
      await filters.getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(`/overview?range=${preset}`);
      const expected = resolveDatePreset(preset);
      await expect(range).toHaveText(formatDateRange(expected.dateFrom, expected.dateTo));
    }

    // Custom range.
    await filters.getByRole("button", { name: "Custom" }).click();
    await filters.getByLabel("From", { exact: true }).fill("2025-01-05");
    await filters.getByLabel("To", { exact: true }).fill("2025-02-20");
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL("/overview?from=2025-01-05&to=2025-02-20");
    await expect(range).toHaveText("5 Jan 2025 – 20 Feb 2025");

    // Branch selector is present but empty until branches are synced.
    const branch = filters.getByRole("combobox", { name: "Branch" });
    await expect(branch).toBeDisabled();
    await expect(branch).toHaveValue("");

    // The filter survives navigation and a reload (it lives in the URL).
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Doctors" }).click();
    await expect(page).toHaveURL("/doctors?from=2025-01-05&to=2025-02-20");
    await page.reload();
    await expect(range).toHaveText("5 Jan 2025 – 20 Feb 2025");
    await expect(page.getByTestId("empty-state")).toContainText("5 Jan 2025 – 20 Feb 2025");
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("the menu opens a slide-in nav and nothing scrolls sideways", async ({ page }) => {
      await page.goto("/overview");
      await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();

      await page.getByRole("button", { name: "Open menu" }).click();
      const nav = page.getByRole("dialog").getByRole("navigation", { name: "Main" });
      await nav.getByRole("link", { name: "Daily" }).click();
      await expect(page).toHaveURL("/daily");
      await expect(page.getByRole("heading", { level: 1, name: "Daily" })).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
