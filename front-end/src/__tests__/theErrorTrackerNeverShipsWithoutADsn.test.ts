// @vitest-environment node
/**
 * A production build with no `VITE_SENTRY_DSN` holds none of the error tracker's client and none of
 * the Sentry SDK (T584): the project's own `vite build` fails when either is in any chunk.
 *
 * `errorTracking.ts` loads the client by an `import()` behind the DSN's check, which a build with
 * no DSN drops; behind a helper the check was not folded, and the build kept the import and emitted
 * the SDK's chunk. Each case builds one entry module through the project's config, as production
 * builds, with the DSN the case sets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, loadConfigFromFile, mergeConfig, type InlineConfig, type UserConfig } from 'vite';

const ROOT = process.cwd();
const SRC = resolve(ROOT, 'src');
const KEY = 'fixturepublickey';
const FIXTURE_DSN = `https://${KEY}@o1.ingest.us.sentry.io/7`;

let scratch: string;

beforeAll(() => {
  // Under `node_modules/`, so an entry's bare `@sentry/browser` resolves as the app's does.
  scratch = mkdtempSync(join(ROOT, 'node_modules', '.tracker-never-ships-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true });
});

/** The project's own `vite.config.ts`, loaded as a production build loads it, with `dsn` set. */
async function projectConfig(dsn: string): Promise<UserConfig> {
  const saved = {
    VITE_SENTRY_DSN: process.env.VITE_SENTRY_DSN,
    VITE_ALLOW_INSECURE_LOCAL_DEV: process.env.VITE_ALLOW_INSECURE_LOCAL_DEV,
  };
  process.env.VITE_SENTRY_DSN = dsn;
  // The config refuses a production build with no reCAPTCHA site key; these are never served.
  process.env.VITE_ALLOW_INSECURE_LOCAL_DEV = 'true';
  try {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      resolve(ROOT, 'vite.config.ts'),
      ROOT,
      'silent',
    );
    return loaded!.config;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Builds, as production does, one entry module whose source is `code`, with `dsn` as the DSN. */
async function buildEntry(name: string, code: string, dsn = ''): Promise<void> {
  const entry = join(scratch, `${name}.ts`);
  writeFileSync(entry, code);
  const one: InlineConfig = {
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry, formats: ['es'] },
      rolldownOptions: { external: ['vue', 'vue-router'] },
    },
  };
  const config = await projectConfig(dsn);
  // Vitest runs under NODE_ENV=test, which Vite reads as a development build; production ships.
  const nodeEnv = process.env.NODE_ENV;
  const savedDsn = process.env.VITE_SENTRY_DSN;
  process.env.NODE_ENV = 'production';
  process.env.VITE_SENTRY_DSN = dsn;
  try {
    await build(mergeConfig(config, one));
  } finally {
    process.env.NODE_ENV = nodeEnv;
    if (savedDsn === undefined) delete process.env.VITE_SENTRY_DSN;
    else process.env.VITE_SENTRY_DSN = savedDsn;
  }
}

const LOADS_THE_TRACKER =
  'import { installErrorTracking, loadErrorTrackingAfterFirstPaint } from ' +
  `'${SRC}/utils/errorTracking';\n` +
  'export { installErrorTracking, loadErrorTrackingAfterFirstPaint };\n';

const IMPORTS_THE_CLIENT =
  `import { startErrorTrackingClient } from '${SRC}/utils/errorTrackingClient';\n` +
  'export { startErrorTrackingClient };\n';

describe('a production build with no DSN', () => {
  it('builds the tracker the app ships, which loads nothing', async () => {
    await expect(buildEntry('loads-the-tracker', LOADS_THE_TRACKER)).resolves.toBeUndefined();
  }, 60_000);

  it('fails when a shipped module imports the client, and names it', async () => {
    await expect(buildEntry('imports-the-client', IMPORTS_THE_CLIENT)).rejects.toThrow(
      /no VITE_SENTRY_DSN[\s\S]*src\/utils\/errorTrackingClient\.ts/,
    );
  }, 60_000);

  it('fails when the client is loaded by an import() no DSN check guards', async () => {
    await expect(
      buildEntry(
        'loads-the-client-unguarded',
        `export const load = () => import('${SRC}/utils/errorTrackingClient');\n`,
      ),
    ).rejects.toThrow(/src\/utils\/errorTrackingClient\.ts/);
  }, 60_000);

  it('fails when a shipped module imports the SDK, and names it', async () => {
    await expect(
      buildEntry(
        'imports-the-sdk',
        "import { BrowserClient } from '@sentry/browser';\nexport { BrowserClient };\n",
      ),
    ).rejects.toThrow(/node_modules\/@sentry\//);
  }, 60_000);

  it.each([['   ']])(
    'counts a blank DSN (%j) as none',
    async (dsn) => {
      await expect(
        buildEntry('loads-the-tracker-blank', LOADS_THE_TRACKER, dsn),
      ).resolves.toBeUndefined();
      await expect(buildEntry('imports-the-client-blank', IMPORTS_THE_CLIENT, dsn)).rejects.toThrow(
        /src\/utils\/errorTrackingClient\.ts/,
      );
    },
    60_000,
  );
});

describe('a production build with a DSN', () => {
  it('builds the client and the SDK', async () => {
    await expect(
      buildEntry('imports-the-client-with-a-dsn', IMPORTS_THE_CLIENT, FIXTURE_DSN),
    ).resolves.toBeUndefined();
  }, 60_000);
});
