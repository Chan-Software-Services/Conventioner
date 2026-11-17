import type { Page, TestInfo } from '@playwright/test';
import { test, expect, BACKEND_URL, TEST_USER } from '../fixtures';
import { disabledWithoutLine, sweep } from './contrastSweep';
import { rememberFieldsAtRest, walkByTab, walkTheMenus, windowsFocused } from './focusSweep';
import {
  detectLayout,
  gates,
  minTargetAt,
  misplacedBars,
  PHONE_MAX_WIDTH,
  PINNED_MAX,
  pinnedBottom,
  SPACE_SCALE,
  TYPE_SCALE,
  type Finding,
  type Pinned,
} from './layoutDetectors';
import {
  openScreen,
  PHONE,
  SCREEN_GROUPS,
  SCREENS,
  signIn,
  type Screen,
  type Size,
} from './screens';
import { seedTheScreens, type TheScreensSeed } from './seedTheScreens';
import { settle } from './settle';

/**
 * The screen sweeps: every screen and state in `SCREENS` (`screens.ts`) walked once, and four
 * checks run on each at the sizes each asks for (T349). Opening a screen and letting it come to rest
 * is most of a sweep's time, so one walk runs them all: per screen one test, and per size one step a
 * check, named `<check> at <width>x<height>`. Each check's findings fail softly, so one screen's
 * test names every check that found something on it, by its step; the read-only checks run first
 * and focus, which moves focus and opens menus, last.
 *
 * Each group of `SCREEN_GROUPS` is one spec file (`screen-sweeps-*.spec.ts`), which walks its
 * screens once; `npx playwright test e2e/screen-sweeps-` runs every group, and `--grep` runs the
 * screens whose names match.
 *
 * **Accessibility**, at a screen's first size: nothing axe can see fails WCAG A or AA. The check is
 * the `expectAccessible` fixture's, configured once in `fixtures.ts`. Playwright's guide is plain
 * that an automated check finds some WCAG failures, not all of them: a pass here is a floor, not a
 * verdict.
 *
 * **Contrast**, at a screen's first size, since contrast does not change with the window: every
 * rendered text node reaches WCAG AA, on the ground it is actually painted on (E16/F01/S05).
 * `src/__tests__/contrast.test.ts` asserts the palette and is kept: it fails in milliseconds with a
 * precise message when `base.css` changes, where this check would only say "something on the
 * Applications screen went dark". What it cannot see is a USAGE. Two failures proved that:
 *
 *   - the Skip button put white text on `--mm-border`, at **1.74:1**. That token is exempt from the
 *     contract on the stated grounds that it "never carries text", so the unit test was structurally
 *     incapable of noticing that it had been made into a fill.
 *   - the current-phase label rendered `--mm-green` on the rail's `#fbfbfa` at **4.43:1**. The token
 *     is correct - 4.59 on white - but white was not the ground it was used on.
 *
 * Each state is also checked for the one disabled state's line (`expectDisabledLine`), the other
 * half of how a disabled control reads.
 *
 * **Layout**, at every size a screen ships at: no screen's layout is broken (T79, from T67's
 * trial). Each state is measured by the detectors in `layoutDetectors.ts`, and the check fails on any
 * finding of a gating kind: the page or an element past the window, a child outside its parent, text
 * clipped, text or controls overlapping, text squeezed into a column, type off the scale, a scroller
 * that draws a bar or has no shade (T217), and a tap target under 44px on a phone (T82). Each
 * failure names the state, the size, the element and the measurement. The noisier kinds (spacing
 * off the scale, uneven gaps, near-miss edges, empty bands, truncated names, nested scrollers, small
 * targets on a desktop) are real drift mixed with what is by design, so they are attached to the
 * test as `layout report`, never failed on.
 *
 * Then, across screens, in a test of each group's own: the market bar stands at the same x and
 * width on every market screen of one size, which is what no screen can see alone (bug 12: the frame
 * at x 0 on the floorplan, x 16 elsewhere); and on a phone no market screen pins more than
 * `PINNED_MAX` of the window's top (T142: the door pinned 409px of 844, half the screen).
 *
 * **Focus**, at a screen's first size and at a phone's width: focus shows on controls only
 * (E38/F01/S01).
 *
 * - A field (`input`, `textarea`, `select`) focused by Tab looks as it did unfocused: no outline,
 *   ring, glow, or border or fill change, on it or on the two boxes around it, which is where the
 *   plan cards and the sign-in page drew theirs. A text field shows its caret and nothing else, by
 *   Daniel's decision on the 2026-10-29 walk.
 * - A button focused by Tab draws a green border and no halo, its own size still: `--focus-border`
 *   on what the green shows on and `--focus-border-on-fill` on a fill it does not, or over a green
 *   border of the button's own. A box around a button may draw it, as a market card does for its
 *   name. It lies inside the edge and not over the words, or clear around the words of a text
 *   button, which has no fill or border to lie on.
 * - Any other control focused by Tab draws the soft halo and no outline, so neither the old ring
 *   nor the browser's own is left anywhere; a control with no shadow of its own may have a box
 *   around it wear the halo. The halo is `--focus-halo` on a light ground and
 *   `--focus-halo-on-dark` on a dark one (the market bar's tabs).
 * - Both hug what they mark: the corners are rounded, and a text control with no fill or border is
 *   about as wide as its words, not the row it sits in.
 * - A dialog's window, which AppDialog focuses when no control in it is ready, draws no outline.
 * - Every menu the state shows (`aria-haspopup="menu"`) is opened with Enter and walked with the
 *   arrow keys, since its items are no Tab stop, and each item is judged as a control.
 *
 * It presses Tab rather than calling `focus()`, since `:focus-visible` is what the keyboard gets.
 * The phone is there because an organizer's screens ship at a desk, but a desk zoomed to 400% is
 * that narrow, and a table too wide for it scrolls, which makes its scroller a keyboard stop of its
 * own; a state that cannot be walked that narrow is marked `deskOnly`.
 */

/** The four checks, in the order each size runs them. */
export const CHECKS = ['accessibility', 'contrast', 'layout', 'focus'] as const;
export type CheckName = (typeof CHECKS)[number];

/** The sizes a check runs a screen at, a copy, since screens share their sizes' arrays. */
export function sizesFor(check: CheckName, s: Screen): Size[] {
  if (check === 'layout') return [...s.sizes];
  const first = s.sizes.slice(0, 1);
  if (check === 'focus' && !s.deskOnly && !first.some((size) => size.width === PHONE.width)) {
    first.push(PHONE);
  }
  return first;
}

/** One size a screen is opened at, and the checks run on it there, in `CHECKS` order. */
export interface Visit {
  size: Size;
  checks: CheckName[];
}

/** Each size any check runs a screen at, once, with the checks it runs there. */
export function visits(s: Screen): Visit[] {
  const out: Visit[] = [];
  for (const check of CHECKS) {
    for (const size of sizesFor(check, s)) {
      let visit = out.find((v) => v.size.width === size.width && v.size.height === size.height);
      if (!visit) out.push((visit = { size, checks: [] }));
      visit.checks.push(check);
    }
  }
  return out;
}

/**
 * The market screen every group also measures the bar on, so two groups whose own screens agree
 * with each other but not with the other group's still fail: each group's bars are held to this
 * one's. It fits a phone, so every group measures a phone market screen's pinned area too.
 */
export const BAR_ANCHOR = 'the result';

/** What the layout check records of each screen for the tests across screens. */
interface Bars {
  /** Where each market screen put its market bar, by window width: screen -> [x, width]. */
  bars: Map<number, Map<string, [number, number]>>;
  /** On a phone, how much of the window's top each market screen pins: screen -> what. */
  pinned: Map<string, Pinned>;
  /** Every screen measured for a bar, by window width, the ones with none among them. */
  measured: Map<number, Set<string>>;
}

/**
 * Records where the open screen put its bar, or that it has none, and on a phone what it pins, so
 * it is not opened again.
 */
async function measureBar(page: Page, state: string, record: Bars): Promise<void> {
  const width = page.viewportSize()!.width;
  if (!record.measured.has(width)) record.measured.set(width, new Set());
  record.measured.get(width)!.add(state);
  // The screen has come to rest (`openScreen`), so a bar it has is drawn.
  const bar = page.getByTestId('market-bar');
  if (!(await bar.count())) return;
  const box = await bar.first().boundingBox();
  if (!box) return;
  if (!record.bars.has(width)) record.bars.set(width, new Map());
  record.bars.get(width)!.set(state, [Math.round(box.x), Math.round(box.width)]);
  if (width <= PHONE_MAX_WIDTH) record.pinned.set(state, await page.evaluate(pinnedBottom));
}

/**
 * Measures each organizer screen of `screens` at each of its sizes no wider than `upTo` that the
 * walk missed.
 */
async function measureTheRest(
  page: Page,
  seed: TheScreensSeed,
  screens: readonly Screen[],
  record: Bars,
  upTo = Infinity,
): Promise<void> {
  // The walk measured each screen it passed; a screen it never reached (a failure moves the run to
  // a new worker, and these maps start empty there) is measured now, and so is the anchor when the
  // other group walks it.
  await signIn(page, 'organizer', seed);
  for (const s of screens.filter((x) => x.who === 'organizer')) {
    for (const size of s.sizes.filter((x) => x.width <= upTo)) {
      if (record.measured.get(size.width)?.has(s.name)) continue;
      await page.setViewportSize(size);
      await openScreen(page, s, seed);
      await measureBar(page, s.name, record);
    }
  }
}

const line = (f: Finding) => `${f.kind} ${f.el}: ${f.detail} (box ${f.box.join(', ')})`;

/** At most this many lines of one state's failure: one overflow drags its whole subtree along. */
const MAX_LINES = 25;

async function expectLaidOut(
  page: Page,
  state: string,
  testInfo: TestInfo,
  record: Bars,
): Promise<void> {
  const { width, height } = page.viewportSize()!;
  const findings = await page.evaluate(detectLayout, {
    spaceScale: SPACE_SCALE,
    textScale: TYPE_SCALE,
    minTarget: minTargetAt(width),
  });
  await measureBar(page, state, record);

  const failing = findings.filter((f) => gates(f, width));
  const reported = findings.filter((f) => !gates(f, width));
  if (reported.length) {
    await testInfo.attach(`layout report, ${width}x${height}`, {
      body: JSON.stringify(reported, null, 1),
      contentType: 'application/json',
    });
  }
  const lines = failing.map(line);
  expect
    .soft(
      lines.length > MAX_LINES
        ? [...lines.slice(0, MAX_LINES), `... and ${lines.length - MAX_LINES} more`]
        : lines,
      `${state} at ${width}x${height} has layout findings`,
    )
    .toEqual([]);
}

/**
 * A screen with no more visible text nodes than this has not rendered, whatever it reports.
 *
 * One, not more: the sparsest state walked is a market's public page, which measures two - the
 * market's name and its address - and a page still loading measures one, "Loading...". The floor
 * is here to catch a blank render, not to pin a design decision about how much copy a screen
 * carries.
 */
const MIN_TEXT_NODES = 1;

async function expectAA(page: Page, state: string): Promise<void> {
  await settle(page);
  const { failures, checked } = await sweep(page);
  expect
    .soft(
      failures.map((f) => `"${f.text}" ${f.ratio}:1 (needs ${f.needs}) ${f.color} on ${f.ground}`),
      `${state} has text below AA`,
    )
    .toEqual([]);
  expect
    .soft(checked, `${state} rendered almost no text, so its pass means nothing`)
    .toBeGreaterThan(MIN_TEXT_NODES);
}

/**
 * Every disabled control is drawn in the one disabled state, its line included (T162): a control of
 * a component's own drawn with `border: none` took the state's beige and ink and no line, so the app
 * showed two disabled looks side by side, and nothing failed. Its words are measured by `expectAA`.
 */
async function expectDisabledLine(page: Page, state: string): Promise<void> {
  expect
    .soft(await disabledWithoutLine(page), `${state} has a disabled control with no line`)
    .toEqual([]);
}

async function expectFocusShown(page: Page, name: string): Promise<void> {
  const state = `${name}, at ${page.viewportSize()?.width}px`;
  // The state's last click leaves the pointer over the page, and a focus that scrolls a box can
  // bring the box around the focused field under it, whose hover fill would read as a look focus
  // drew.
  await page.mouse.move(0, 0);
  const stops = await rememberFieldsAtRest(page);
  const { failures, checked } = await walkByTab(page, state);
  // A state that draws keyboard stops and was walked to none of them proves nothing.
  if (stops > 0) expect.soft(checked, `${state}: Tab reached nothing`).toBeGreaterThan(0);
  failures.push(...(await walkTheMenus(page, state)));
  failures.push(...(await windowsFocused(page, state)));
  expect.soft(failures).toEqual([]);
}

/**
 * Registers the sweeps of one group of `SCREEN_GROUPS`, for its spec file: a test a screen, and the
 * two layout tests across its screens.
 */
export function sweepTheScreens(group: keyof typeof SCREEN_GROUPS): void {
  const screens: readonly Screen[] = SCREEN_GROUPS[group];
  const anchor = SCREENS.find((s) => s.name === BAR_ANCHOR);
  if (!anchor) throw new Error(`no screen is named ${BAR_ANCHOR}, the market bar's anchor`);
  const across = screens.includes(anchor) ? screens : [...screens, anchor];
  const record: Bars = { bars: new Map(), pinned: new Map(), measured: new Map() };
  let seed: TheScreensSeed;

  test.describe(`The screen sweeps, ${group}`, () => {
    test.beforeAll(async ({ request }) => {
      test.setTimeout(120_000);
      seed = await seedTheScreens(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
    });

    for (const s of screens) {
      const plan = visits(s);
      test(s.name, async ({ page, expectAccessible }, testInfo) => {
        test.setTimeout(60_000 * plan.reduce((n, v) => n + v.checks.length, 0));
        const run: Record<CheckName, () => Promise<void>> = {
          accessibility: () => expectAccessible(s.name, { soft: true }),
          contrast: async () => {
            await expectAA(page, s.name);
            await expectDisabledLine(page, s.name);
          },
          layout: () => expectLaidOut(page, s.name, testInfo, record),
          focus: () => expectFocusShown(page, s.name),
        };
        await signIn(page, s.who, seed);
        for (const { size, checks } of plan) {
          const at = `${size.width}x${size.height}`;
          await page.setViewportSize(size);
          await test.step(`open at ${at}`, () => openScreen(page, s, seed));
          for (const check of checks) await test.step(`${check} at ${at}`, run[check]);
        }
      });
    }

    test('the market bar stands in one place on every market screen', async ({ page }) => {
      test.setTimeout(10 * 60_000);
      await measureTheRest(page, seed, across, record);

      // A check that measured no bars passes on nothing: a renamed test id would leave it green.
      const most = Math.max(0, ...[...record.bars.values()].map((placed) => placed.size));
      expect(
        most,
        'the market bar was measured on two market screens of one size',
      ).toBeGreaterThanOrEqual(2);

      for (const { width, usual, apart } of misplacedBars(record.bars)) {
        expect
          .soft(
            apart,
            `at ${width}px the market bar stands at ${usual} on the other market screens`,
          )
          .toEqual([]);
      }
    });

    test(`on a phone no market screen pins more than ${PINNED_MAX}px of the window`, async ({
      page,
    }) => {
      test.setTimeout(10 * 60_000);
      await measureTheRest(page, seed, across, record, PHONE_MAX_WIDTH);

      // The door, Tools, the Assignments page and what opens over them: a check that measured none
      // passes on nothing.
      expect(
        record.pinned.size,
        'the pinned area was measured on a phone market screen',
      ).toBeGreaterThan(0);
      const over = [...record.pinned]
        .filter(([, p]) => p.bottom > PINNED_MAX)
        .map(([state, p]) => `${state}: ${p.bottom}px, to the bottom of ${p.el}`);
      expect(over, `on a phone a market screen pins at most ${PINNED_MAX}px of the window`).toEqual(
        [],
      );
    });
  });
}
