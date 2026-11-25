/**
 * The spec files that need the stack to themselves: each holds a test that needs state every test
 * shares to stay as it left it between two of its steps, so a second worker running beside it
 * would change that state under it. `playwright.config.ts` runs them in the `chromium-serial`
 * project, and CI's shards (`scripts/e2e-shards.ts`) run that project first, at one worker, before
 * the rest at the config's workers. When a new spec joins the list is in
 * docs/implementation/testing/e2e-patterns.md, "Specs that need the stack to themselves".
 *
 * Each entry is a spec file's name in `e2e/` without `.spec.ts`, and its comment names the kind of
 * shared state that puts it here.
 */
export const SERIAL_SPECS: readonly string[] = [
  // The fixture organizer's sessions: it ends TEST_USER's sessions.
  'a-failure-says-what-to-do',
  // The fixture organizer's whole market list.
  'finding-a-market',
  // The fixture organizer's whole market list.
  'markets-opening-words',
  // The profiler's database-wide read counts.
  'people-at-scale-market',
  // The profiler's database-wide read counts.
  'people-at-scale-organization',
  // The fixture organizer's whole market list.
  'remember-me',
  // The sign-in counters: it needs the counters it cleared.
  'remember-me-on-the-vendor-page',
  // The sign-in counters: it asks for five codes and expects the sixth refused.
  'sign-in-is-bounded',
  // The fixture organizer's whole market list.
  'sign-in-fits-a-phone',
  // The fixture organizer's whole market list.
  'smoke',
  // The fixture organizer's whole market list.
  'the-app-bar',
  // The sign-in counters: it asserts a limit is reached.
  'the-sign-in-says-what-to-do-next',
];

/** The paths of the named spec files in `e2e/`, each whole, as a Playwright project's `testMatch`
 * reads them. */
export function specPattern(names: readonly string[]): RegExp {
  return new RegExp(`/e2e/(${names.join('|')})\\.spec\\.ts$`);
}

/** The paths of the serial spec files. */
export const serialSpecs = specPattern(SERIAL_SPECS);
