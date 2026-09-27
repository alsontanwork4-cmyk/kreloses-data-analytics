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

import type { Role } from "@/auth/roles";

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
  { href: "/settings", label: "Settings", icon: Settings, section: "admin", role: "owner" },
];
