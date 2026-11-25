// @vitest-environment node
/**
 * Every host-side client of a local stack dials 127.0.0.1, and the dev server listens there (T48).
 *
 * A stack publishes on 127.0.0.1 only. `localhost` is tried as ::1 first, and macOS hands a port
 * held on 127.0.0.1 to any program that listens on IPv6, so a client dialling `localhost:<port>`
 * can reach that program instead: twice a gate run's Playwright got `ERR_INVALID_HTTP_RESPONSE` from
 * its own stack's port. And a dev server left to bind `localhost` listens on ::1 alone, where
 * nothing dialling 127.0.0.1 finds it. So this loads each client's own configuration (Playwright's,
 * the suite's fixtures, Vite's proxy) and starts the dev server to see where it listens.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createServer, loadConfigFromFile, type ViteDevServer } from 'vite';

import {
  LOADS_A_CONFIG,
  playwrightConfigWith,
  restoreStackVars,
  SLOT_7,
  withStack,
} from './helpers/aStackOfItsOwn';

const ROOT = process.cwd();

afterEach(restoreStackVars);

describe('the clients of a local stack dial 127.0.0.1', () => {
  it(
    "Playwright browses the stack's front end there",
    async () => {
      const config = await playwrightConfigWith(SLOT_7);
      expect(config.use?.baseURL).toBe('http://127.0.0.1:5243');
    },
    LOADS_A_CONFIG,
  );

  it(
    "the suite calls the stack's back end there",
    async () => {
      const { BACKEND_URL } = await withStack(SLOT_7, () => import('../../e2e/fixtures'));
      expect(BACKEND_URL).toBe('https://127.0.0.1:5071');
    },
    LOADS_A_CONFIG,
  );

  it(
    "CI's single stack is reached there too",
    async () => {
      const config = await playwrightConfigWith({ CI: 'true' });
      const { BACKEND_URL } = await withStack({ CI: 'true' }, () => import('../../e2e/fixtures'));
      expect(new URL(String(config.use?.baseURL)).hostname).toBe('127.0.0.1');
      expect(new URL(BACKEND_URL).hostname).toBe('127.0.0.1');
    },
    LOADS_A_CONFIG,
  );

  it(
    "Vite's proxy sends /api to a native back end there",
    async () => {
      const proxy = await withStack({}, async () => {
        const loaded = await loadConfigFromFile(
          { command: 'serve', mode: 'development' },
          resolve(ROOT, 'vite.config.ts'),
          ROOT,
          'silent',
        );
        return loaded!.config.server?.proxy?.['/api'];
      });
      const target = typeof proxy === 'object' ? proxy.target : undefined;
      expect(new URL(String(target)).hostname).toBe('127.0.0.1');
    },
    LOADS_A_CONFIG,
  );
});

describe('the dev server', () => {
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('listens on 127.0.0.1, where the docs and the email links send a browser', async () => {
    server = await createServer({
      configFile: resolve(ROOT, 'vite.config.ts'),
      root: ROOT,
      logLevel: 'silent',
      server: { port: 0, watch: null },
    });
    await server.listen();
    const address = server.httpServer!.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
  }, 60_000);
});
