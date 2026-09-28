import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the React Server Components bundler; tests are server code.
      "server-only": fileURLToPath(new URL("./src/test-support/empty-module.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    // Opt-in tests against the real Kreloses run only via `npm run test:live` (vitest.live.config.mts).
    exclude: [...configDefaults.exclude, "**/*.live.test.ts"],
    environment: "node",
    globalSetup: ["src/db/vitest-global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
