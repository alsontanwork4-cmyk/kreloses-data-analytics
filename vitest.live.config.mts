import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { loadLocalEnv } from "./scripts/env";

/**
 * `npm run test:live`: the opt-in smoke tests against the REAL Kreloses (`*.live.test.ts`), skipped
 * unless KRELOSES_TEST_EMAIL / KRELOSES_TEST_PASSWORD are set (in the shell or `.env.local`).
 * No database or Supabase stack needed.
 */
loadLocalEnv();

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test-support/empty-module.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.live.test.ts"],
    environment: "node",
    reporters: ["verbose"],
  },
});
