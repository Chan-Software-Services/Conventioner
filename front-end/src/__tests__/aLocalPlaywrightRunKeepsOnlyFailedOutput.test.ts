// @vitest-environment node
/**
 * A local Playwright run keeps a test's output directory only when the test fails, and CI keeps
 * every test's.
 *
 * Specs write screenshots of their own into `testInfo.outputPath()` on every pass, and a worker's
 * repeat runs each get an `--output` directory of their own, so a run that kept every passing
 * test's directory left gigabytes behind on the machine. CI uploads `test-results/` whole, so it
 * keeps everything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Every variable that names a stack or the CI run, so the machine running this cannot leak one in. */
const STACK_VARS = [
  'CI',
  'COMPOSE_PROJECT_NAME',
  'TH_BACKEND_PORT',
  'TH_FRONTEND_PORT',
  'TH_MONGO_PORT',
  'BACKEND_URL',
  'FRONTEND_PORT',
];

/** A stack as `th-compose.sh` exports it, slot 7's ports, since the config reads its port. */
const SLOT_7 = {
  COMPOSE_PROJECT_NAME: 'conventioner-7',
  TH_BACKEND_PORT: '5071',
  TH_FRONTEND_PORT: '5243',
  TH_MONGO_PORT: '27087',
};

/** Importing Playwright's config outlasts the 5 s default on a loaded machine. */
const LOADS_A_CONFIG = 60_000;

const saved = Object.fromEntries(STACK_VARS.map((name) => [name, process.env[name]]));

/** Load Playwright's config fresh with only `env` set of the variables above. */
async function configWith(env: Record<string, string>) {
  vi.resetModules();
  for (const name of STACK_VARS) delete process.env[name];
  Object.assign(process.env, env);
  return (await import('../../playwright.config')).default;
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("what a Playwright run keeps of a test's output", () => {
  it(
    "a local run keeps only a failed test's",
    async () => {
      expect((await configWith(SLOT_7)).preserveOutput).toBe('failures-only');
    },
    LOADS_A_CONFIG,
  );

  it(
    "CI keeps every test's",
    async () => {
      expect((await configWith({ ...SLOT_7, CI: 'true' })).preserveOutput).toBe('always');
    },
    LOADS_A_CONFIG,
  );
});
