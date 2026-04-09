import { defineConfig, devices } from '@playwright/test'

/**
 * Standalone Playwright config for the tier 0 cutover smoke test.
 * Targets PRODUCTION at https://crm.thelaunchpadincubator.com — does not
 * spin up a local server. Single chromium worker.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'tier0-cutover-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 900 },
    // Use the system chromium that's already cached
    ...devices['Desktop Chrome'],
  },
})
