/** Safe to import from client components. */
export const ROLES = ["owner", "manager"] as const;

/** `owner` can do everything; `manager` can view the dashboard. */
export type Role = (typeof ROLES)[number];

/** A signed-in, allow-listed user. */
export interface AppUser {
  email: string;
  role: Role;
}

/** Whether `user` may do something that needs `role`. Owners satisfy every role. */
export function hasRole(user: Pick<AppUser, "role">, role: Role): boolean {
  return user.role === "owner" || user.role === role;
}
