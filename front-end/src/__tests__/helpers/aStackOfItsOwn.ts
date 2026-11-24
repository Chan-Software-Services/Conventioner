/**
 * Loading a config that reads the stack (Playwright's, the E2E suite's fixtures, Vite's) with only
 * the variables a test names, so the machine running the test cannot leak its own stack in.
 *
 * A test file calls `afterEach(restoreStackVars)`, so each test's variables are gone before the next.
 */
import { vi } from 'vitest';

/** Every variable that names a stack, a URL or the CI run. */
const STACK_VARS = [
  'CI',
  'COMPOSE_PROJECT_NAME',
  'TH_BACKEND_PORT',
  'TH_FRONTEND_PORT',
  'TH_MONGO_PORT',
  'BACKEND_URL',
  'FRONTEND_PORT',
  'VITE_BACKEND_URL',
];

/** A stack as `th-compose.sh` exports it, slot 7's ports. */
export const SLOT_7 = {
  COMPOSE_PROJECT_NAME: 'conventioner-7',
  TH_BACKEND_PORT: '5071',
  TH_FRONTEND_PORT: '5243',
  TH_MONGO_PORT: '27087',
};

/**
 * A test that imports a whole config, Playwright's with `@playwright/test` or Vite's through
 * `loadConfigFromFile`, outlasts the 5 s default on a loaded machine, as the Lucide build test does.
 */
export const LOADS_A_CONFIG = 60_000;

const saved = Object.fromEntries(STACK_VARS.map((name) => [name, process.env[name]]));

/** Load modules fresh with only `env` naming the stack: `stack()` is computed once per process. */
export async function withStack<T>(
  env: Record<string, string>,
  load: () => Promise<T>,
): Promise<T> {
  vi.resetModules();
  for (const name of STACK_VARS) delete process.env[name];
  Object.assign(process.env, env);
  return load();
}

/** Playwright's config, loaded fresh with only `env` naming the stack. */
export function playwrightConfigWith(env: Record<string, string>) {
  return withStack(env, async () => (await import('../../../playwright.config')).default);
}

/** Put back every variable `withStack` changed, as the machine had it. */
export function restoreStackVars() {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
