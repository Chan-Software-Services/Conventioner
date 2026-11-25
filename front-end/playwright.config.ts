import { defineConfig, devices } from '@playwright/test';
import { frontendURL, stack } from './e2e/helpers/stack';
import { serialSpecs } from './e2e/serialSpecs';

const BASE_PORT = parseInt(process.env.FRONTEND_PORT ?? '', 10) || stack().frontendPort;

const ciReporters = [
  ['list'] as const,
  ['html', { open: 'never' }] as const,
  // CI's shards run two passes (scripts/e2e-shards.ts), each naming its own report.
  ['json', { outputFile: process.env.E2E_JSON_OUTPUT ?? 'test-results/results.json' }] as const,
];

/** CI's shards set E2E_WORKERS (scripts/e2e-shards.ts); unset, or not a positive integer, is 1. */
function workers(value: string | undefined): number {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: !!process.env.CI,
  // The serial project's files (e2e/serialSpecs.ts) run at one worker all the same, but only the
  // shard script keeps them apart from the rest: a plain run at more than one runs them beside it.
  workers: workers(process.env.E2E_WORKERS),
  reporter: process.env.CI
    ? ciReporters
    : [['list'] as const, ['html', { open: 'never' }] as const],
  use: {
    baseURL: frontendURL(BASE_PORT),
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure-and-retries',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-serial',
      testMatch: serialSpecs,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: serialSpecs,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'echo "Web server is managed externally (docker compose)"',
    port: BASE_PORT,
    reuseExistingServer: true,
  },
});
