import { cloudflarePool } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: cloudflarePool({
      main: "./test/worker.ts",
      miniflare: {
        bindings: {
          ACCESS_CLIENT_ID: "test-client",
          ACCESS_CLIENT_SECRET: "test-secret",
          AUTHORIZED_SSH_KEY_NAME: "test-key",
        },
      },
    }),
    include: ["test/**/*.test.ts"],
  },
});
