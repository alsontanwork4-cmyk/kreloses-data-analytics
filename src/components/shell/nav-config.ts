import {
  BadgePercent,
  CalendarDays,
  LayoutDashboard,
  PieChart,
  Plug,
  RefreshCw,
  Repeat,
  Settings,
  ShoppingBasket,
  Stethoscope,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { hasRole, type Role } from "@/auth/roles";

/**
 * The single source of the dashboard navigation (sidebar, mobile menu and the e2e smoke test all
 * read it). To add a page: add its route under `src/app/(dashboard)/` and one entry here.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  section: NavSection;
  /** Minimum role to see the entry. Omitted = every signed-in user. The page must still call `requireRole`. */
  role?: Role;
  /**
   * Where the link actually goes, when `href` is a section that would only redirect (e.g. Settings →
   * its first tab). Linking straight there avoids a redirect on every click. `href` still decides
   * when the entry is highlighted.
   */
  landing?: (role: Role) => string | undefined;
}

export type NavSection = "analytics" | "admin";

export const NAV_SECTIONS: Record<NavSection, string> = {
  analytics: "Analytics",
  admin: "Admin",
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard, section: "analytics" },
  { href: "/doctors", label: "Doctors", icon: Stethoscope, section: "analytics" },
  { href: "/trends", label: "Trends", icon: TrendingUp, section: "analytics" },
  { href: "/mix", label: "Mix", icon: PieChart, section: "analytics" },
  { href: "/upsell", label: "Upsell", icon: ShoppingBasket, section: "analytics" },
  { href: "/retention", label: "Retention", icon: Repeat, section: "analytics" },
  { href: "/discounts", label: "Discounts", icon: BadgePercent, section: "analytics" },
  { href: "/daily", label: "Daily", icon: CalendarDays, section: "analytics" },
  { href: "/connections", label: "Connections", icon: Plug, section: "admin", role: "owner" },
  { href: "/sync", label: "Sync status", icon: RefreshCw, section: "admin" },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    section: "admin",
    role: "owner",
    landing: (role) => settingsNavItemsFor(role)[0]?.href,
  },
];

/** The path a nav entry links to for `role`. */
export function navLinkHref(item: NavItem, role: Role): string {
  return item.landing?.(role) ?? item.href;
}

/**
 * The Settings sub-navigation (tabs under the "Settings" heading), in display order. `/settings`
 * itself redirects to the first entry the user's role may see. To add a settings page: create
 * `src/app/(dashboard)/settings/<name>/page.tsx` (it must call `requireRole(...)` itself and render
 * its content in `<SettingsSection>`), then add one entry here. The sub-nav and the e2e suite pick
 * it up. Reserved slots are below; replace your ticket's comment with the entry.
 */
export interface SettingsNavItem {
  href: `/settings/${string}`;
  label: string;
  /** Minimum role to see the tab. Omitted = every signed-in user. The page must still call `requireRole`. */
  role?: Role;
}

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  // #5 doctor-name mapping: { href: "/settings/doctors", label: "Doctors", role: "owner" },

  // #9 item → service-mix group mapping: { href: "/settings/items", label: "Items", role: "owner" },

  { href: "/settings/users", label: "Users", role: "owner" },
];

/** The settings tabs `role` may see, in order (the first is where `/settings` lands). */
export function settingsNavItemsFor(role: Role): SettingsNavItem[] {
  return SETTINGS_NAV_ITEMS.filter((item) => !item.role || hasRole({ role }, item.role));
}
