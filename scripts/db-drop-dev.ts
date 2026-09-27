/**
 * Drops a development database created with `npm run db:create-dev`.
 *
 *   npm run db:drop-dev -- kx_dev_issue5
 */
import { dropDatabase } from "../src/db/admin";

import { loadLocalEnv } from "./env";

async function main() {
  loadLocalEnv();
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: npm run db:drop-dev -- <kx_dev_name>");
    process.exit(1);
  }
  await dropDatabase(name);
  console.log(`Dropped ${name} (if it existed)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
