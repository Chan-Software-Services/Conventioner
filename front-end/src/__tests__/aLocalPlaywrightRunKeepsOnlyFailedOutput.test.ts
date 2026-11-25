// @vitest-environment node
/**
 * A local Playwright run keeps a test's output directory only when the test fails, and CI keeps
 * every test's.
 *
 * Specs write screenshots of their own into `testInfo.outputPath()` on every pass, and a worker's
 * repeat runs each get an `--output` directory of their own, so a run that kept every passing
 * test's directory left gigabytes behind on the machine. CI uploads `test-results/` whole when a
 * shard fails, so it keeps everything.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  LOADS_A_CONFIG,
  playwrightConfigWith,
  restoreStackVars,
  SLOT_7,
} from './helpers/aStackOfItsOwn';

afterEach(restoreStackVars);

describe("what a Playwright run keeps of a test's output", () => {
  it(
    "a local run keeps only a failed test's",
    async () => {
      expect((await playwrightConfigWith(SLOT_7)).preserveOutput).toBe('failures-only');
    },
    LOADS_A_CONFIG,
  );

  it(
    "CI keeps every test's",
    async () => {
      expect((await playwrightConfigWith({ ...SLOT_7, CI: 'true' })).preserveOutput).toBe('always');
    },
    LOADS_A_CONFIG,
  );
});
