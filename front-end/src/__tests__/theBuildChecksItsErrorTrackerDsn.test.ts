// @vitest-environment node
/**
 * A front-end build refuses an error tracker DSN it could not send to (T584).
 *
 * `VITE_SENTRY_DSN` is optional, and blank builds with tracking off. Set, it must be a DSN, and its
 * host must be one the Content-Security-Policy's `connect-src` in `vercel.json` allows, or every
 * event the browser tried to send would be refused by the policy instead. This loads the project's
 * own `vite.config.ts` as a build loads it, after the case has set the environment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';

const ROOT = process.cwd();

const NAMES = ['VITE_SENTRY_DSN', 'VITE_ALLOW_INSECURE_LOCAL_DEV', 'VERCEL'] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** Loads the config as a build under the hatch, as CI builds, with `dsn` as the DSN. */
async function build(dsn: string): Promise<unknown> {
  process.env.VITE_SENTRY_DSN = dsn;
  process.env.VITE_ALLOW_INSECURE_LOCAL_DEV = 'true';
  delete process.env.VERCEL;
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    resolve(ROOT, 'vite.config.ts'),
    ROOT,
    'silent',
  );
  return loaded?.config;
}

const KEY = 'fixturepublickey';

describe("a build's error tracker DSN", () => {
  it.each([[''], ['   ']])('may be blank (%j), and builds with tracking off', async (dsn) => {
    await expect(build(dsn)).resolves.toBeDefined();
  });

  it("may be a DSN on Sentry's US ingest host", async () => {
    await expect(build(`https://${KEY}@o4508.ingest.us.sentry.io/4509`)).resolves.toBeDefined();
  });

  it.each([
    ['not a URL', 'a-dsn'],
    ['over plain HTTP', `http://${KEY}@o4508.ingest.us.sentry.io/4509`],
    ['with no key', 'https://o4508.ingest.us.sentry.io/4509'],
    ['with no project', `https://${KEY}@o4508.ingest.us.sentry.io/`],
    ['with a word for a project', `https://${KEY}@o4508.ingest.us.sentry.io/project`],
    ['with a query', `https://${KEY}@o4508.ingest.us.sentry.io/4509?x=1`],
  ])('refuses one %s, naming the variable', async (_case, dsn) => {
    await expect(build(dsn)).rejects.toThrow(
      /^VITE_SENTRY_DSN is not a Sentry DSN \(https:\/\/<key>@<host>\/<project id>\)/,
    );
  });

  it.each([
    ["Sentry's EU region", `https://${KEY}@o4508.ingest.de.sentry.io/4509`],
    ['the US region with no organization', `https://${KEY}@ingest.us.sentry.io/4509`],
    ['another host', `https://${KEY}@sentry.example.com/4509`],
    ['a host ending like the allowed one', `https://${KEY}@o4508.evilingest.us.sentry.io/4509`],
  ])('refuses one on %s, which connect-src does not allow', async (_case, dsn) => {
    const host = new URL(dsn).host;
    await expect(build(dsn)).rejects.toThrow(
      `VITE_SENTRY_DSN names the host ${host}, which the Content-Security-Policy's connect-src ` +
        'in vercel.json does not allow',
    );
  });
});
