import { dropDatabase } from "../src/db/admin";

import { run } from "./support/run";

export default async function globalTeardown(): Promise<void> {
  await dropDatabase(run.databaseName);
}
