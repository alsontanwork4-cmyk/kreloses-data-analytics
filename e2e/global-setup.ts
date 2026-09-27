import { addAppUser } from "../src/auth/allow-list";
import { createDatabase, dropStaleDatabases } from "../src/db/admin";
import { applyMigrations } from "../src/db/migrate";

import { withRunDatabase } from "./support/db";
import { run } from "./support/run";

/** Creates this run's database (migrated) and puts the test manager on the allow-list. */
export default async function globalSetup(): Promise<void> {
  await dropStaleDatabases("kx_e2e_", 2 * 60 * 60 * 1000);
  await createDatabase(run.databaseName);
  await withRunDatabase(async (sql) => {
    await applyMigrations(sql);
    await addAppUser(sql, run.managerEmail, "manager");
  });
}
