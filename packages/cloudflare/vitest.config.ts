import { cloudflarePool } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: cloudflarePool({
      main: "./test/worker.ts",
      miniflare: {
        bindings: {
          CLOUD_TASK_AUTH_TOKEN: "test-token",
          CLOUD_TASK_ROUTER_SECRET: "test-router-secret",
        },
      },
    }),
    include: ["test/**/*.test.ts"],
  },
});
