import { runBackfill } from "@/sync/backfill";
import { backfillConfigFromEnv } from "@/sync/backfill-config";
import { backfillSyncDeps } from "@/sync/context";
import { handleBackfillCron } from "@/sync/cron";

/**
 * The history backfill (#8): ONE chunk per connection whose backfill is active, then it answers.
 * Called every 15 minutes during the night window by the GitHub Actions workflow
 * `.github/workflows/backfill.yml` (Vercel Hobby allows only one cron a day, used by the nightly
 * sync). A PUBLIC path (`PUBLIC_EXACT_PATHS`): not wrapped in `withUser` because the workflow has no
 * session — it authenticates itself with `Authorization: Bearer <CRON_SECRET>` and refuses
 * everything when `CRON_SECRET` is not set (`handleBackfillCron`, src/sync/cron.ts).
 *
 * Outside the night window (`BACKFILL_NIGHT_WINDOW`, default 00:00–06:00 Kuala Lumpur time), when
 * tonight's request budget is spent or every backfill is complete it returns at once. Each chunk
 * stops within 240 s, under `maxDuration`.
 */
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  return handleBackfillCron(request, {
    secret: process.env.CRON_SECRET,
    run: () => {
      const config = backfillConfigFromEnv();
      return runBackfill(backfillSyncDeps(config.requestDelayMs), { config });
    },
  });
}
