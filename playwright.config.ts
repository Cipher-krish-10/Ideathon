import { defineConfig, devices } from "@playwright/test";

/**
 * E2E configuration.
 *
 * Runs against a production build so the demo path is exercised exactly as it
 * will be on stage. Serial, because the tests share one database and one
 * intervention.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run start -- --port 3100",
    // The E2E suite must NEVER call the real payment provider. A test that
    // depends on a third party fails for reasons unrelated to the code, and
    // creating 26 live payment links per run is both slow and rate-limited.
    env: { PAYMENT_PROVIDER: "fake" },
    url: "http://localhost:3100/api/metrics/dashboard",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
  },
});
