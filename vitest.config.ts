import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Playwright owns tests/e2e; vitest must not try to run those.
    exclude: ["tests/e2e/**", "node_modules/**"],
    // Integration tests share one Postgres database; running files in parallel
    // would let them race on the same rows.
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
      // `server-only` throws outside a React Server context. Point it at the
      // package's own no-op build (the same file Next resolves via the
      // "react-server" export condition) so server modules are testable.
      "server-only": path.resolve(process.cwd(), "node_modules/server-only/empty.js"),
    },
  },
});
