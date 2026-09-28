import { syncDeps, syncTimeBudgetMs } from "@/sync/context";
import { handleNightlyCron } from "@/sync/cron";
import { nightlyWindowDays, runNightlySync } from "@/sync/nightly";

/**
 * The nightly sync (#6), called by Vercel Cron (`vercel.json`: once a day at 19:00 UTC = 03:00 in
 * Kuala Lumpur; on the Hobby plan Vercel may run it any time within that hour). A PUBLIC path
 * (`PUBLIC_PATHS`): it is not wrapped in `withUser` because Vercel Cron has no session — it
 * authenticates itself with `Authorization: Bearer <CRON_SECRET>` and refuses everything when
 * `CRON_SECRET` is not set (`handleNightlyCron`, src/sync/cron.ts).
 *
 * The connections are synced one after another within this one invocation; the sync's budget
 * (250 s shared, see `runNightlySync`) keeps it under `maxDuration`.
 */
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  return handleNightlyCron(request, {
    secret: process.env.CRON_SECRET,
    run: () => runNightlySync(syncDeps(), { windowDays: nightlyWindowDays(), maxRunBudgetMs: syncTimeBudgetMs() }),
  });
}
