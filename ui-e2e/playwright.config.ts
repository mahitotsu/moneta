import { defineConfig, devices } from "@playwright/test";

// Targets the deployed CloudFront URL only (docs/adr/0014) -- same "manual/on-demand, live
// deployed stack" placement api-e2e/README.md already established relative to infra/, not a new
// kind of test environment. Each spec resolves the URL itself via support/stackOutputs.ts
// (fetchStackOutputs), the same way every api-e2e scenario resolves its own API URLs, so there's
// no baseURL to configure here.
export default defineConfig({
  testDir: "./scenarios",
  timeout: 120_000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: "list",
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    // Chromium only (docs/adr/0014) -- this harness verifies user journeys work at all, not
    // cross-browser rendering, and this WSL sandbox only has headless Chromium available anyway.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
