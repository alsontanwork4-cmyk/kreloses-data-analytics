import { redirect } from "next/navigation";

import { HOME_PATH } from "@/auth/paths";
import { requireUser } from "@/auth/session";
import { filterSearchParamsOnly, withSearchParams } from "@/filters";

export default async function RootPage({ searchParams }: PageProps<"/">) {
  await requireUser();
  redirect(withSearchParams(HOME_PATH, filterSearchParamsOnly(await searchParams)));
}
