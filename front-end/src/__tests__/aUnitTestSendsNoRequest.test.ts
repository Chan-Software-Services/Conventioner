/**
 * A unit test makes no network call: the setup refuses every request a test sends, and fails the
 * test that sent it. The first two tests here send requests on purpose and take them back, so the
 * setup's check after each has nothing left to fail; the third checks that nothing is left to take.
 */
import { describe, expect, it } from 'vitest';

import { api } from '@/utils/api';
import { takeSentRequests } from './support/noNetwork';

// The app's axios sends to its host's address, which no unit run sets in CI and a machine's
// `front-end/.env` may.
const TABLES = `${import.meta.env.VITE_FLASK_HOST ?? ''}/markets/m1/tables`;

describe('a request a unit test sends', () => {
  it('is refused through the app’s axios, and named with the test that sent it', async () => {
    await expect(api.get('/markets/m1/tables')).rejects.toThrow(
      `a unit test sent GET ${TABLES}: stub it`,
    );
    expect(takeSentRequests()).toEqual([
      {
        request: `GET ${TABLES}`,
        test: 'a request a unit test sends > is refused through the app’s axios, and named with the test that sent it',
      },
    ]);
  });

  it('is refused through fetch, the window’s and the global one', async () => {
    await expect(window.fetch('/logout', { method: 'POST' })).rejects.toThrow(
      'a unit test sent POST /logout: stub it',
    );
    await expect(globalThis.fetch(new URL('http://localhost:3000/plan'))).rejects.toThrow(
      'a unit test sent GET http://localhost:3000/plan: stub it',
    );
    expect(takeSentRequests().map((sent) => sent.request)).toEqual([
      'POST /logout',
      'GET http://localhost:3000/plan',
    ]);
  });

  it('leaves nothing to take once taken', () => {
    expect(takeSentRequests()).toEqual([]);
  });
});
