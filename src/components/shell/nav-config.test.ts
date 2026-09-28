import { describe, expect, it } from "vitest";

import { SETTINGS_NAV_ITEMS, settingsNavItemsFor } from "./nav-config";

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
