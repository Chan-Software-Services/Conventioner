import { defineConfig, devices } from '@playwright/test';
import { frontendURL, stack } from './e2e/helpers/stack';

const BASE_PORT = parseInt(process.env.FRONTEND_PORT ?? '', 10) || stack().frontendPort;

const ciReporters = [
  ['list'] as const,
  ['html', { open: 'never' }] as const,
  // CI's shards run two passes (scripts/e2e-shards.ts), each naming its own report.
  ['json', { outputFile: process.env.E2E_JSON_OUTPUT ?? 'test-results/results.json' }] as const,
];

/**
 * The spec files that share state a second worker would change under them, run in a project of
 * their own, at one worker and apart from the rest: the profiler's database-wide read counts, the
 * sign-in attempt counters, the fixture organizer's sessions and whole market list, and the fake
 * Discord's servers.
 */
const SERIAL_SPECS = [
  'a-failure-says-what-to-do',
  'choices-at-scale',
  'exporting-discord-columns',
  'finding-a-market',
  'giving-the-discord-role',
  'lists-at-scale',
  'markets-opening-words',
  'people-at-scale-market',
  'people-at-scale-organization',
  'possible-discord-matches',
  'remember-me',
  'remember-me-on-the-vendor-page',
  'sign-in-fits-a-phone',
  'smoke',
  'the-app-bar',
  'the-sign-in-says-what-to-do-next',
  'the-tools-tab',
  'who-is-in-the-discord-server',
];
const serialSpecs = new RegExp(`/e2e/(${SERIAL_SPECS.join('|')})\\.spec\\.ts$`);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  failOnFlakyTests: !!process.env.CI,
  // CI's shards set E2E_WORKERS; the serial project's files run at one worker all the same.
  workers: Number(process.env.E2E_WORKERS) || 1,
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
