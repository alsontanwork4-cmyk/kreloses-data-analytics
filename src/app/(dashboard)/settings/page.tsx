import { redirect } from "next/navigation";

import { FORBIDDEN_PATH } from "@/auth/paths";
import { requireUser } from "@/auth/session";
import { settingsNavItemsFor } from "@/components/shell/nav-config";

/** `/settings` opens the first settings page the user may see (none for a manager today). */
export default async function SettingsPage() {
  const user = await requireUser();
  const [first] = settingsNavItemsFor(user.role);
  redirect(first?.href ?? FORBIDDEN_PATH);
}
