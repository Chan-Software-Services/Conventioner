import { test as playwrightTest, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { LoginPage } from './pages/LoginPage';
import { settle } from './helpers/settle';
import { stack } from './helpers/stack';
import { startMongoSession } from './helpers/mongo';
import { hideDevToolsPanel } from './helpers/hideDevToolsPanel';
import { withTheTestMap } from './helpers/testMap';
import {
  annotateANetworkChange,
  attachWhatTheBrowserSaid,
  watchTheBrowser,
} from './helpers/browserSaid';

/** Playwright's `test`, recording the test map when `TEST_MAP_OUT` is set (`helpers/testMap.ts`). */
const base = withTheTestMap(playwrightTest);

export const TEST_USER = {
  email: 'e2e@example.com',
  password: 'e2epassword123',
};

/**
 * Verified, and deliberately in no organization - therefore reaching no market. Created by
 * `scripts/seed_fixture.sh` alongside `TEST_USER`, so the zero-market states have a real account
 * to be shown on rather than a mocked one.
 */
export const NO_ORG_USER = {
  email: 'e2e-noorg@example.com',
  password: 'e2enoorg123',
};

export const BACKEND_URL = process.env.BACKEND_URL || stack().backendURL;

/**
 * The API at the address the app's own pages call it, through the dev server's proxy, for a call
 * made with a page's cookies (`page.request`), so it reaches the back end as the page's own calls
 * do (E38/F14/S01). A request context of its own may call `BACKEND_URL`.
 */
export const APP_API = '/api';

async function login(page: Page, email: string, password: string) {
  await new LoginPage(page).signInToMarkets(email, password);
}

/**
 * What axe checks: every WCAG 2.0, 2.1 and 2.2 rule at levels A and AA (axe tags no 2.2 rule at A).
 *
 * `color-contrast` is off because the screen sweeps' contrast check (`helpers/screenSweeps.ts`)
 * owns contrast, measuring every text node on the ground it is composited onto, so one defect fails
 * one check rather than two. The two `main` landmark rules are axe best practices, not WCAG, and
 * are on because the app shell keeps exactly one `<main>` on every route.
 */
const AXE_OPTIONS = {
  runOnly: {
    type: 'tag' as const,
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  },
  rules: {
    'color-contrast': { enabled: false },
    'landmark-one-main': { enabled: true },
    'landmark-no-duplicate-main': { enabled: true },
  },
};

/**
 * Fails on any violation axe finds on the page as it stands, one line per element:
 * `rule (impact) target`, never the whole result, so a failure reads as what to fix and where.
 * `soft` fails the test and lets it go on, as the screen sweeps' other checks of the state do.
 */
async function expectAccessible(page: Page, state: string, { soft = false } = {}): Promise<void> {
  await settle(page);
  const { violations } = await new AxeBuilder({ page }).options(AXE_OPTIONS).analyze();
  (soft ? expect.soft : expect)(
    violations.flatMap((v) =>
      v.nodes.map((node) => `${v.id} (${v.impact}) ${node.target.join(' ')}`),
    ),
    `${state} has accessibility violations`,
  ).toEqual([]);
}

export const test = base.extend<
  {
    authenticatedPage: Page;
    expectAccessible: (state: string, options?: { soft?: boolean }) => Promise<void>;
  },
  { mongoSession: void }
>({
  /**
   * Each worker process starts its Mongo session (`helpers/mongo.ts`) before its first test, so
   * that first start, slow on a loaded CI runner, is not counted against a test that seeds.
   */
  mongoSession: [
    async ({}, use) => {
      await startMongoSession();
      await use();
    },
    { scope: 'worker', auto: true, timeout: 90_000 },
  ],
  page: async ({ page }, use, testInfo) => {
    await hideDevToolsPanel(page.context());
    const said = watchTheBrowser(page);
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      const lines = said();
      await attachWhatTheBrowserSaid(testInfo, lines);
      annotateANetworkChange(testInfo, lines);
    }
  },
  authenticatedPage: async ({ page }, use) => {
    await login(page, TEST_USER.email, TEST_USER.password);
    await use(page);
  },
  expectAccessible: async ({ page }, use) => {
    await use((state, options) => expectAccessible(page, state, options));
  },
});

export { expect } from '@playwright/test';
export { LoginPage } from './pages/LoginPage';
export { MarketSetupPage } from './pages/MarketSetupPage';
export { ResultPage } from './pages/ResultPage';
export { NewMarketPage } from './pages/NewMarketPage';
export { VendorsPage } from './pages/VendorsPage';
export { TablesPage } from './pages/TablesPage';
export { AttendanceStatusPage } from './pages/AttendanceStatusPage';
export { OrganizationsPage } from './pages/OrganizationsPage';
export { ManageMarketPage } from './pages/ManageMarketPage';
export { PasswordResetPage } from './pages/PasswordResetPage';
export { ApplicationFormPage } from './pages/ApplicationFormPage';
export { VendorPage } from './pages/VendorPage';
export { CsvImportPage } from './pages/CsvImportPage';
export { ApplicationMonitorPage } from './pages/ApplicationMonitorPage';
