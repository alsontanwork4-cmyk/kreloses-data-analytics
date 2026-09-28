import { describe, expect, it } from "vitest";

import { NAV_ITEMS, SETTINGS_NAV_ITEMS, navLinkHref, settingsNavItemsFor } from "./nav-config";

describe("nav link targets", () => {
  const settings = NAV_ITEMS.find((item) => item.href === "/settings")!;

  it("sends the Settings link straight to the first settings tab (no redirect on navigation)", () => {
    expect(navLinkHref(settings, "owner")).toBe(settingsNavItemsFor("owner")[0]!.href);
  });

  it("links every other page to its own path", () => {
    for (const item of NAV_ITEMS.filter((entry) => entry !== settings)) {
      expect(navLinkHref(item, "owner")).toBe(item.href);
    }
  });
});

describe("settings tabs", () => {
  it("shows the owner every settings page, in order", () => {
    expect(settingsNavItemsFor("owner").map((item) => item.href)).toEqual(SETTINGS_NAV_ITEMS.map((item) => item.href));
    expect(settingsNavItemsFor("owner").map((item) => item.href)).toContain("/settings/users");
  });

  it("shows a manager no settings page (so /settings is forbidden to them)", () => {
    expect(settingsNavItemsFor("manager")).toEqual([]);
  });

  it("has one entry per page", () => {
    const hrefs = SETTINGS_NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
