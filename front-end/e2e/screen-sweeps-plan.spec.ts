import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures';
import { CHECKS, visits, type CheckName } from './helpers/screenSweeps';
import { PHONE, SCREEN_GROUPS, SCREENS, type Screen, type Size } from './helpers/screens';

/**
 * The screen sweeps' one walk runs each check where the four sweeps it replaced ran it (T349).
 *
 * Until T349 each check was a spec file of its own that walked the screens itself, by
 * `walkTheScreens(test, { everySize, alsoAt })`: accessibility and contrast at a screen's first
 * size, focus there and at a phone unless the screen is `deskOnly`, and layout at every size it
 * ships at. `walked` is that rule, kept as it was, so the walk that serves all four can be held to
 * it.
 */

const FRONT_END = dirname(dirname(fileURLToPath(import.meta.url)));

type ListedSuite = { title: string; file: string; suites?: ListedSuite[] };

/**
 * The environment the listing runs in: this run's, less the JSON reporter's output settings. A run
 * that sends its JSON report to a file through `PLAYWRIGHT_JSON_OUTPUT_FILE` would pass that on,
 * and the listing would then print its list as text, not JSON, to stdout.
 */
function listingEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('PLAYWRIGHT_JSON_OUTPUT_')),
  );
}

/** Each describe Playwright registers, with the spec file it comes from, by `--list`. */
function registeredDescribes(): { title: string; file: string }[] {
  const listed = JSON.parse(
    execFileSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
      cwd: FRONT_END,
      encoding: 'utf8',
      env: listingEnv(),
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as { suites: ListedSuite[] };
  const describes = (suite: ListedSuite, file: string): { title: string; file: string }[] =>
    (suite.suites ?? []).flatMap((s) => [{ title: s.title, file }, ...describes(s, file)]);
  return listed.suites.flatMap((specFile) => describes(specFile, specFile.file));
}

/** The sizes the old sweep with these options walked a screen at. */
function walked(s: Screen, { everySize, alsoAt }: { everySize: boolean; alsoAt?: Size }): Size[] {
  const sizes = everySize ? [...s.sizes] : s.sizes.slice(0, 1);
  if (alsoAt && !s.deskOnly && !sizes.some((size) => size.width === alsoAt.width)) {
    sizes.push(alsoAt);
  }
  return sizes;
}

const OLD_SWEEPS: Record<CheckName, { everySize: boolean; alsoAt?: Size }> = {
  accessibility: { everySize: false },
  contrast: { everySize: false },
  layout: { everySize: true },
  focus: { everySize: false, alsoAt: PHONE },
};

const at = (s: Screen, size: Size) => `${s.name} at ${size.width}x${size.height}`;

test.describe('The screen sweeps walk once', () => {
  test('each check reaches the screens and sizes its own sweep did, and no others', () => {
    for (const check of CHECKS) {
      const now = SCREENS.flatMap((s) =>
        visits(s)
          .filter((v) => v.checks.includes(check))
          .map((v) => at(s, v.size)),
      );
      const before = SCREENS.flatMap((s) =>
        walked(s, OLD_SWEEPS[check]).map((size) => at(s, size)),
      );
      expect(now.sort(), `the ${check} check`).toEqual(before.sort());
    }
  });

  test('a screen is opened once a size, its checks in order, the focus walk last', () => {
    for (const s of SCREENS) {
      const plan = visits(s);
      const sizes = plan.map((v) => `${v.size.width}x${v.size.height}`);
      expect(new Set(sizes).size, s.name).toBe(sizes.length);
      for (const { checks } of plan) {
        expect(checks, s.name).toEqual(CHECKS.filter((c) => checks.includes(c)));
      }
    }
  });

  test('the phone the focus check adds leaves the sizes a screen ships at', () => {
    const before = SCREENS.map((s) => s.sizes.map((size) => size.width));
    for (const s of SCREENS) visits(s);
    expect(SCREENS.map((s) => s.sizes.map((size) => size.width))).toEqual(before);
  });

  test('every screen is in one group, and every group is swept by one spec file', () => {
    const grouped = Object.values(SCREEN_GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(new Set(SCREENS.map((s) => s.name)).size, 'every screen has a name of its own').toBe(
      SCREENS.length,
    );

    const registered = registeredDescribes();
    for (const group of Object.keys(SCREEN_GROUPS)) {
      const files = registered
        .filter((d) => d.title === `The screen sweeps, ${group}`)
        .map((d) => d.file);
      expect(files, `the ${group} group`).toHaveLength(1);
    }
    const sweeps = registered.filter((d) => d.title.startsWith('The screen sweeps, '));
    expect(sweeps.map((d) => d.title.slice('The screen sweeps, '.length)).sort()).toEqual(
      Object.keys(SCREEN_GROUPS).sort(),
    );
  });
});
