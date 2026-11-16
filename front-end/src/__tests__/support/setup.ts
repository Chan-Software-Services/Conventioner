/**
 * Every unit test gets a fresh Pinia (E21/F02).
 *
 * The open market lives in one store, and the phase rail, the market screens and the review
 * highlights all reach for it - so any test that mounts one of them needs a Pinia, and no test may
 * see a market another test left behind.
 */
import { afterEach, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { refuseRequests, takeSentRequests } from './noNetwork';

beforeEach(() => {
  setActivePinia(createPinia());
});

// jsdom has no layout, so it does not implement scrolling and logs an error for each call. A screen
// that starts a new step at the top of the page (the form tab, E33/F01/S01) scrolls; nothing here
// can see where to. A test that runs in Node (`@vitest-environment node`) has no window at all.
if (typeof window !== 'undefined') {
  window.scrollTo = () => {};
}

// A unit test makes no network call (`noNetwork.ts`): a request is refused, and fails its test. A
// test that stubs `fetch` (`vi.stubGlobal`, `vi.spyOn`) stubs it over the refusal.
refuseRequests();
afterEach(() => {
  const sent = takeSentRequests();
  if (sent.length) {
    const named = sent.map(({ request, test }) => `${request} (in "${test}")`).join(', ');
    throw new Error(`A unit test makes no network call, and this one sent ${named}: stub it.`);
  }
});
