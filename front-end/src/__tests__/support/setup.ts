/**
 * Every unit test gets a fresh Pinia (E21/F02), and a happy-dom unit test sends no request
 * (`noNetwork.ts`).
 *
 * The open market lives in one store, and the phase rail, the market screens and the review
 * highlights all reach for it - so any test that mounts one of them needs a Pinia, and no test may
 * see a market another test left behind.
 *
 * A request a test sends through XHR or `fetch` is refused, and fails the test that sent it, or the
 * file, for one sent after its last test.
 */
import { beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { refuseRequests } from './noNetwork';

beforeEach(() => {
  setActivePinia(createPinia());
});

// jsdom has no layout, so it does not implement scrolling and logs an error for each call. A screen
// that starts a new step at the top of the page (the form tab, E33/F01/S01) scrolls; nothing here
// can see where to. A test that runs in Node (`@vitest-environment node`) has no window at all.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}

// A test that stubs `fetch` (`vi.stubGlobal`, `vi.spyOn`) stubs it over the refusal.
refuseRequests();

// No test reads the error tracker's DSN from the shell or a `.env` (T584), as the back end's
// conftest clears `SENTRY_DSN`: a test that needs one stubs it (`vi.stubEnv`), and a build test
// loading `vite.config.ts` then builds with none, so a DSN a developer exported cannot change a
// result. Blank rather than deleted, since a `.env` file's value fills in a name the shell lacks.
process.env.VITE_SENTRY_DSN = '';
