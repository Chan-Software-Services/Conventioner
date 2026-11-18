import { test, expect, TEST_USER, BACKEND_URL, APP_API } from './fixtures';
import { marketSetupPath, oneByOnePath } from './helpers/marketScreens';
import { completePlan, ensureTestOrg, loginViaApi } from './helpers/seeds';
import { decideReviewSetup } from './helpers/decideReviewSetup';
import { seedApplication } from './helpers/seedApplication';
import { seedPhaseMarket } from './helpers/seedPhaseMarket';
import { settle } from './helpers/settle';
import { ApplicationMonitorPage } from './pages/ApplicationMonitorPage';
import type { APIRequestContext, Page } from '@playwright/test';
import { saveApplicationForm } from './helpers/saveApplicationForm';

/**
 * Which answers a reviewer reads first (E19/F03/S01).
 *
 * A reviewer working a queue reads two or three things and decides. The card used to show nine,
 * ordered by a heuristic that guessed - the organizer's own questions before the essential ones,
 * on the reasoning that custom questions distinguish applicants. This replaces the guess with
 * what the organizer actually said.
 *
 * The mark lives on the MARKET, not on a form field, which is what lets it name an ESSENTIAL
 * answer - and an essential availability answer can be the whole decision. A form-field flag
 * could only ever have marked half the card, and would have frozen with the form at the first
 * application, which is the moment an organizer first learns what they needed.
 */

/** A form with enough custom questions that hiding some of them is worth doing. */
const FORM = {
  fields: [
    { key: 'business_name', label: 'Business name', type: 'text', required: true, order: 0 },
    { key: 'what_you_sell', label: 'What you sell', type: 'text', required: true, order: 1 },
    { key: 'instagram', label: 'Instagram', type: 'text', required: false, order: 2 },
    { key: 'power_needed', label: 'Power needed', type: 'text', required: false, order: 3 },
    { key: 'heard_from', label: 'How you heard of us', type: 'text', required: false, order: 4 },
  ],
};

const ANSWERS = {
  business_name: 'Ember Ceramics',
  what_you_sell: 'Hand-thrown stoneware',
  instagram: '@emberceramics',
  power_needed: 'One outlet',
  heard_from: 'A friend who vends',
  essential_full_name: 'Nadia Ember',
};

async function seedMarketWithAForm(
  request: APIRequestContext,
  form: { fields: unknown[] } = FORM,
): Promise<{ marketId: string; market: unknown }> {
  await loginViaApi(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const orgId = await ensureTestOrg(request, BACKEND_URL, TEST_USER.email, TEST_USER.password);
  const headers = { 'Content-Type': 'application/json' };

  const created = await request.post(`${BACKEND_URL}/markets`, {
    headers,
    data: {
      name: `E2E Highlights ${Date.now()}`,
      creationDate: new Date().toISOString(),
      organizationId: orgId,
      // Complete, so it may open applications: a review card is of a market that has (E31/F01).
      setupObject: completePlan(),
      intakeMode: 'form',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { market_id: marketId } = (await created.json()) as { market_id: string };

  await saveApplicationForm(request, BACKEND_URL, marketId, form, headers);
  await decideReviewSetup(request, BACKEND_URL, marketId);
  const opened = await request.post(`${BACKEND_URL}/markets/${marketId}/transition`, {
    headers,
    data: { toPhase: 'applications' },
  });
  expect(opened.ok(), await opened.text()).toBeTruthy();

  const fetched = await request.get(`${BACKEND_URL}/markets/${marketId}`, { headers });
  return { marketId, market: ((await fetched.json()) as { market: unknown }).market };
}

test.describe('What a reviewer reads first', () => {
  let marketId: string;

  test.beforeAll(async ({ request }) => {
    ({ marketId } = await seedMarketWithAForm(request));
    // Two applicants, so the disclosure's open state can be watched ACROSS cards - which is the
    // criterion that keeps this from taxing a reviewer once per card at card forty.
    seedApplication(marketId, 'nadia@ember.test', ANSWERS);
    seedApplication(marketId, 'rafi@kiln.test', { ...ANSWERS, business_name: 'Kiln & Co' });
  });

  async function openTheMarket(page: import('@playwright/test').Page, tab: string): Promise<void> {
    await page.goto('/login');
    await page.evaluate((user) => {
      localStorage.setItem('user', JSON.stringify(user));
    }, TEST_USER.email);
    await page.goto(marketSetupPath(marketId, tab));
  }

  test('a market that marked nothing shows every answer, with no disclosure', async ({
    authenticatedPage: page,
  }) => {
    // An empty list is not a reason to hide an application: the card reads exactly as it always
    // has. This runs first, so it describes the seeded market before the next test marks anything.
    await openTheMarket(page, 'applications');
    const monitor = new ApplicationMonitorPage(page);
    await monitor.switchTo();
    await monitor.waitForLoaded();

    await expect(monitor.answers).toBeVisible();
    await expect(page.getByTestId('app-monitor-leading')).toHaveCount(0);
    await expect(page.getByTestId('app-monitor-rest')).toHaveCount(0);
  });

  test('an organizer marks answers, and the card then leads with them', async ({
    authenticatedPage: page,
  }) => {
    await openTheMarket(page, 'form');
    // What a reviewer reads first is the form tab's last step, Review setup (E33/F01/S01).
    await page.getByTestId('form-step-review').click();

    // One custom question and one ESSENTIAL answer - the case a flag on a FormField could never
    // have covered, because the essential answers are not form fields at all.
    const highlights = page.getByTestId('review-highlights');
    await expect(highlights).toBeVisible();

    // Each toggle is its own save, so each is awaited: navigating while one is still in flight
    // reads a market that is a click behind, which is a race in the TEST and not in the product.
    for (const key of ['what_you_sell', 'essential_full_name']) {
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes(`/markets/${marketId}/review-highlights`) &&
            response.request().method() === 'PUT',
        ),
        highlights.getByTestId(`review-highlight-${key}`).click(),
      ]);
    }

    // It saved, rather than only ticking a box: the market itself carries it now.
    const response = await page.request.get(`${APP_API}/markets/${marketId}`);
    const body = (await response.json()) as { market: { reviewHighlights?: string[] } };
    expect(body.market.reviewHighlights).toEqual(['what_you_sell', 'essential_full_name']);

    await page.goto(oneByOnePath(marketId));
    const monitor = new ApplicationMonitorPage(page);
    await monitor.waitForLoaded();

    const leading = page.getByTestId('app-monitor-leading');
    await expect(leading).toBeVisible();
    await expect(leading.locator('dt')).toHaveText(['What you sell', 'Full name']);

    // The rest are hidden, and the disclosure says how many without being opened.
    const rest = page.getByTestId('app-monitor-rest');
    await expect(rest).toBeVisible();
    await expect(page.getByTestId('app-monitor-rest-summary')).toHaveText('4 more answers');
    await expect(rest.locator('dt').first()).not.toBeVisible();

    // Opening it once holds for the whole session - a reviewer does not reopen this forty times.
    await page.getByTestId('app-monitor-rest-summary').click();
    await expect(rest.locator('dt').first()).toBeVisible();

    // Onto the next card - whichever the queue puts up, since its order is not this test's point.
    const first = ((await monitor.email.textContent()) ?? '').trim();
    await monitor.nextButton.click();
    await expect(monitor.email).not.toHaveText(first);
    await expect(page.getByTestId('app-monitor-rest')).toHaveJSProperty('open', true);
    await expect(rest.locator('dt').first()).toBeVisible();
  });

  test('unmarking every answer returns the card to showing all of them', async ({
    authenticatedPage: page,
  }) => {
    await openTheMarket(page, 'form');
    await page.getByTestId('form-step-review').click();
    const highlights = page.getByTestId('review-highlights');
    await expect(highlights.getByTestId('review-highlight-what_you_sell')).toBeVisible();

    for (const key of ['what_you_sell', 'essential_full_name']) {
      const choice = highlights.getByTestId(`review-highlight-${key}`);
      if (!(await choice.locator('input').isChecked())) continue;
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes(`/markets/${marketId}/review-highlights`) &&
            response.request().method() === 'PUT',
        ),
        choice.click(),
      ]);
    }

    await page.goto(oneByOnePath(marketId));
    const monitor = new ApplicationMonitorPage(page);
    await monitor.waitForLoaded();

    await expect(monitor.answers).toBeVisible();
    await expect(page.getByTestId('app-monitor-rest')).toHaveCount(0);
  });

  /**
   * The point of the whole feature (E19/F03/S02).
   *
   * An organizer authoring a form is guessing what will matter. A reviewer on card twelve KNOWS -
   * and by then the form has FROZEN, because an application exists. This is why the list lives on
   * the market and not on the form: on the form it would be settable only before it was knowable.
   */
  test('a reviewer changes what leads the card from the queue, with the form frozen', async ({
    authenticatedPage: page,
  }) => {
    await openTheMarket(page, 'form');

    // The precondition this story is FOR: applications exist, so the form builder is locked.
    await page.getByTestId('form-step-questions').click();
    await expect(page.getByTestId('form-builder-lock-banner')).toBeVisible();

    await page.goto(oneByOnePath(marketId));
    const monitor = new ApplicationMonitorPage(page);
    await monitor.waitForLoaded();

    // Where the reviewer is now, so it can be shown they are still there afterwards.
    const before = ((await monitor.email.textContent()) ?? '').trim();

    await monitor.openChooseHighlights();
    const highlights = page.getByTestId('review-highlights');

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/markets/${marketId}/review-highlights`) &&
          response.request().method() === 'PUT',
      ),
      highlights.getByTestId('review-highlight-instagram').click(),
    ]);

    // The tick is saved as it is made: nothing asks for a save, and Done only closes.
    await monitor.chooseHighlightsDone.click();
    await expect(monitor.chooseHighlightsDialog).toHaveCount(0);

    // The card in front of them changed, without leaving the queue and without a reload.
    const leading = page.getByTestId('app-monitor-leading');
    await expect(leading.locator('dt')).toHaveText(['Instagram']);
    await expect(page.getByTestId('app-monitor-rest-summary')).toHaveText('5 more answers');

    // And they are still on the same application: the marks change what the card SHOWS, never
    // which one is up.
    await expect(monitor.email).toHaveText(before);

    // One list, not two: the form builder reads back what the queue wrote.
    await page.goto(marketSetupPath(marketId, 'form'));
    await page.getByTestId('form-step-review').click();
    await expect(
      page
        .getByTestId('review-highlights')
        .getByTestId('review-highlight-instagram')
        .locator('input'),
    ).toBeChecked();

    // And it is there for whoever reviews next - a fresh load of the queue, not this page's state.
    await page.goto(oneByOnePath(marketId));
    await monitor.waitForLoaded();
    await expect(page.getByTestId('app-monitor-leading').locator('dt')).toHaveText(['Instagram']);
  });
});

/**
 * A queue of its own: a test in either describe below may give a verdict, which would move the
 * others' cards.
 */
async function aQueue(
  request: APIRequestContext,
  page: Page,
  form = FORM,
): Promise<ApplicationMonitorPage> {
  const { marketId } = await seedMarketWithAForm(request, form);
  seedApplication(marketId, 'nadia@ember.test', ANSWERS);
  seedApplication(marketId, 'rafi@kiln.test', { ...ANSWERS, business_name: 'Kiln & Co' });
  seedApplication(marketId, 'sana@loom.test', { ...ANSWERS, business_name: 'Loom & Co' });
  const monitor = new ApplicationMonitorPage(page);
  await monitor.goto(marketId);
  await monitor.waitForLoaded();
  await expect(monitor.email).toBeVisible({ timeout: 15000 });
  return monitor;
}

/**
 * The ticks open in a dialog over the card (T217), where they used to unfold between its answers and
 * its verdict buttons: the card stays where it is, the same application is up after, and a verdict
 * key never reaches a card the reviewer cannot see.
 */
test.describe('Choosing what leads the card, in a dialog', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('it opens over the card, which does not move, with one Done and no Cancel', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    await expect(monitor.chooseHighlightsButton).toHaveText('Choose what leads the card');
    await expect(monitor.chooseHighlightsButton).not.toHaveAttribute('aria-expanded');
    // The opener first, as a reviewer scrolls to it: a click scrolls an opener below the fold into
    // view, and that scroll, not the dialog, would move the card between the two measures.
    await monitor.chooseHighlightsButton.scrollIntoViewIfNeeded();
    const approve = await monitor.approveButton.boundingBox();

    await monitor.openChooseHighlights();

    await expect(monitor.chooseHighlightsDialog).toHaveAttribute(
      'aria-label',
      'Choose what leads the card',
    );
    await expect(page.getByTestId('choose-highlights-cancel-button')).toHaveCount(0);
    await expect(monitor.chooseHighlightsDialog.locator('footer button')).toHaveText(['Done']);
    // The first tick has the keyboard, and the card behind has not moved.
    await expect(
      page.getByTestId('review-highlights').locator('input[type="checkbox"]').first(),
    ).toBeFocused();
    expect(await monitor.approveButton.boundingBox()).toEqual(approve);
  });

  test('in a short window the ticks scroll under a title and a Done that stay', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    await page.setViewportSize({ width: 1280, height: 420 });
    await monitor.openChooseHighlights();

    const body = page.getByTestId('choose-highlights-body');
    const title = monitor.chooseHighlightsDialog.getByRole('heading', { level: 2 });
    const titleAt = await title.boundingBox();
    await expect(page.getByTestId('choose-highlights-shade-bottom')).toBeVisible();

    await body.hover();
    await page.mouse.wheel(0, 2000);
    await expect(page.getByTestId('choose-highlights-shade-bottom')).toHaveCount(0);
    await expect(page.getByTestId('choose-highlights-shade-top')).toBeVisible();

    expect(await title.boundingBox()).toEqual(titleAt);
    const done = (await monitor.chooseHighlightsDone.boundingBox())!;
    expect(done.y + done.height).toBeLessThanOrEqual(420);
  });

  test('A, R, S, N and Z do nothing to the card, from a tick or from Done', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    // A verdict first, so Z has one to undo.
    await monitor.approveButton.click();
    await expect(monitor.undoLine).toBeVisible();
    await expect(monitor.approveButton).toBeEnabled();
    const up = ((await monitor.email.textContent()) ?? '').trim();

    // A verdict, an undo, a follow-up or a hand-out; a key may renew the claim, which moves nothing.
    const moved: string[] = [];
    page.on('request', (sent) => {
      if (/\/review(\/next|\/undo)?$|\/verdicts|\/follow-up/.test(new URL(sent.url()).pathname)) {
        moved.push(sent.url());
      }
    });

    await monitor.openChooseHighlights();
    for (const focused of [
      page.getByTestId('review-highlights').locator('input[type="checkbox"]').first(),
      monitor.chooseHighlightsDone,
    ]) {
      await focused.focus();
      for (const key of ['a', 'r', 's', 'n', 'z']) await page.keyboard.press(key);
    }
    await settle(page);

    expect(moved).toEqual([]);
    await expect(monitor.chooseHighlightsDialog).toBeVisible();
    await expect(page.getByTestId('follow-up-window')).toHaveCount(0);

    await monitor.chooseHighlightsDone.click();
    await expect(monitor.chooseHighlightsDialog).toHaveCount(0);
    await expect(monitor.email).toHaveText(up);
    await expect(monitor.undoLine).toBeVisible();

    // And it was the dialog that held them: with it closed, the same key is a verdict.
    await page.keyboard.press('a');
    await expect(monitor.email).not.toHaveText(up);
  });

  test('Done, the close, Escape and the backdrop each give focus back, the same card up', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    const up = ((await monitor.email.textContent()) ?? '').trim();
    const ways: [string, () => Promise<void>][] = [
      ['Done', () => monitor.chooseHighlightsDone.click()],
      ['the close', () => page.getByTestId('choose-highlights-close-button').click()],
      ['Escape', () => page.keyboard.press('Escape')],
      [
        'the backdrop',
        () => page.getByTestId('choose-highlights-background').click({ position: { x: 4, y: 4 } }),
      ],
    ];
    for (const [how, close] of ways) {
      await monitor.openChooseHighlights();
      await close();
      await expect(monitor.chooseHighlightsDialog, how).toHaveCount(0);
      await expect(monitor.chooseHighlightsButton, how).toBeFocused();
      await expect(monitor.email, how).toHaveText(up);
    }
  });

  test('a tick that cannot be saved is said in the dialog, and taken back', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    await page.route('**/review-highlights', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'no' } })
        : route.continue(),
    );
    await monitor.openChooseHighlights();

    const tick = page.getByTestId('review-highlight-instagram').locator('input');
    await tick.click();

    await expect(page.getByTestId('choose-highlights-error')).toBeVisible();
    await expect(tick).not.toBeChecked();
    await expect(monitor.chooseHighlightsDialog).toBeVisible();

    // Read once: the next opening starts clean.
    await monitor.chooseHighlightsDone.click();
    await monitor.openChooseHighlights();
    await expect(page.getByTestId('choose-highlights-error')).toHaveCount(0);
  });
});

/** A form of thirty questions of its own, so the ticks outgrow a phone's window. */
const LONG_FORM = {
  fields: Array.from({ length: 30 }, (_, order) => ({
    key: `question_${order + 1}`,
    label: `Question ${order + 1}`,
    type: 'text',
    required: false,
    order,
  })),
};

/** A phone's window less the gutter, 24px above and below. */
const PHONE = { width: 390, height: 844 };
const PHONE_CAP = PHONE.height - 48;
/** Under Done: the actions' own 8px and the window's 16px more. */
const UNDER_DONE = 24;

/**
 * On a phone the chooser is as tall as its ticks need, up to the window less the gutter (T446):
 * every other long dialog fills a phone's window whatever it holds, which left a usual short list
 * with a band of white above Done.
 */
test.describe('Choosing what leads the card, on a phone', () => {
  test.use({ viewport: PHONE });

  async function measured(page: Page) {
    const window = page.getByTestId('choose-highlights-window');
    const body = page.getByTestId('choose-highlights-body');
    const done = page.getByTestId('choose-highlights-done');
    const [windowBox, doneBox] = await Promise.all([window.boundingBox(), done.boundingBox()]);
    return {
      height: windowBox!.height,
      underDone: windowBox!.y + windowBox!.height - (doneBox!.y + doneBox!.height),
      overflow: await body.evaluate((el) => el.scrollHeight - el.clientHeight),
    };
  }

  test('a short list ends just under Done, with no band of white above it', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    await monitor.openChooseHighlights();

    const { height, underDone, overflow } = await measured(page);
    expect(overflow, 'the ticks all show').toBeLessThanOrEqual(1);
    expect(height, 'shorter than the window less the gutter').toBeLessThan(PHONE_CAP - 1);
    expect(underDone, 'the window ends under Done').toBeCloseTo(UNDER_DONE, 0);
    await expect(page.getByTestId('choose-highlights-shade-bottom')).toHaveCount(0);
    await expect(monitor.chooseHighlightsDone).toBeInViewport({ ratio: 1 });
  });

  test('with an error it still fits, the error in view above Done', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page);
    await page.route('**/review-highlights', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, json: { error: 'no' } })
        : route.continue(),
    );
    await monitor.openChooseHighlights();
    const before = await measured(page);

    await page.getByTestId('review-highlight-instagram').locator('input').click();
    const error = page.getByTestId('choose-highlights-error');
    await expect(error).toBeVisible();

    const { height, underDone, overflow } = await measured(page);
    expect(overflow, 'the ticks all show').toBeLessThanOrEqual(1);
    expect(height, 'grown by the error alone').toBeGreaterThan(before.height);
    expect(height, 'shorter than the window less the gutter').toBeLessThan(PHONE_CAP - 1);
    expect(underDone, 'the window ends under Done').toBeCloseTo(UNDER_DONE, 0);
    await expect(error).toBeInViewport({ ratio: 1 });
    const [errorBox, doneBox] = await Promise.all([
      error.boundingBox(),
      monitor.chooseHighlightsDone.boundingBox(),
    ]);
    expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(doneBox!.y);
  });

  test('a long list stops at the window less the gutter, its title and Done in view as it scrolls', async ({
    authenticatedPage: page,
    request,
  }) => {
    const monitor = await aQueue(request, page, LONG_FORM);
    await monitor.openChooseHighlights();

    const { height, underDone, overflow } = await measured(page);
    expect(height, 'the window less the gutter').toBeCloseTo(PHONE_CAP, 0);
    expect(underDone, 'the window ends under Done').toBeCloseTo(UNDER_DONE, 0);
    expect(overflow, 'the ticks scroll').toBeGreaterThan(1);

    const title = monitor.chooseHighlightsDialog.getByRole('heading', { level: 2 });
    const [titleAt, doneAt] = await Promise.all([
      title.boundingBox(),
      monitor.chooseHighlightsDone.boundingBox(),
    ]);
    const body = page.getByTestId('choose-highlights-body');
    const box = (await body.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(async () => {
      await page.mouse.wheel(0, 100_000);
      expect(
        await body.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
      ).toBeLessThanOrEqual(1);
    }, 'the wheel reaches the last tick').toPass({ timeout: 5000 });

    await expect(page.getByTestId('review-highlight-question_30')).toBeInViewport({ ratio: 1 });
    for (const [part, at] of [
      [title, titleAt],
      [monitor.chooseHighlightsDone, doneAt],
    ] as const) {
      await expect(part).toBeInViewport({ ratio: 1 });
      expect(await part.boundingBox()).toEqual(at);
    }
  });
});

/**
 * Review waits on what a reviewer reads first (T206): a draft whose organizer has decided nothing is
 * not opened for review by accident. The rail leads to Review setup, which offers "Nothing leads the
 * card" as one click; ticking an answer decides it too and replaces the "none".
 */
test.describe('A draft decides what a reviewer reads first', () => {
  test('the rail leads to Review setup, and Nothing leads the card decides it in one click', async ({
    authenticatedPage: page,
  }) => {
    const { marketId } = await seedPhaseMarket(
      page.request,
      APP_API,
      TEST_USER.email,
      TEST_USER.password,
      { intakeMode: 'form', reviewSetupUndecided: true },
    );
    // The automatic rejections decided, so this is all the move waits on.
    const rules = await page.request.put(`${APP_API}/markets/${marketId}/rejection-rules`, {
      data: { rules: [], noAutomaticRejections: true },
    });
    expect(rules.ok(), await rules.text()).toBeTruthy();

    await page.goto(marketSetupPath(marketId, 'form'));
    const fix = page.getByTestId('phase-rail-fix');
    const open = page.getByTestId('phase-transition-applications');
    await expect(fix).toHaveText('Decide what reviewers read first', { timeout: 15000 });
    await expect(open).toBeDisabled();

    await fix.click();

    await expect(page).toHaveURL(/\/form\?step=review$/);
    // The rail offers no link to where the organizer already is.
    await expect(fix).toHaveCount(0);
    const notice = page.getByTestId('review-highlights-undecided');
    await expect(notice).toHaveText('Not decided yet. Opening applications waits on this.');

    const highlightsWrite = () =>
      page.waitForResponse(
        (response) =>
          response.url().includes(`/markets/${marketId}/review-highlights`) &&
          response.request().method() === 'PUT',
      );
    await Promise.all([highlightsWrite(), page.getByTestId('review-highlights-none').click()]);

    const readBack = page.getByTestId('review-highlights-none-chosen');
    await expect(readBack).toHaveText(
      "Nothing leads the card: a reviewer reads every answer, in the form's order.",
    );
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId('review-highlights-none')).toHaveCount(0);
    // The rail moves on: nothing else refuses the move, so it offers the move itself.
    await expect(open).toBeEnabled();

    // A tick replaces the "none"; taking the last one off in draft asks again.
    const category = page.getByTestId('review-highlight-category');
    await Promise.all([highlightsWrite(), category.click()]);
    await expect(readBack).toHaveCount(0);
    await expect(open).toBeEnabled();

    await Promise.all([highlightsWrite(), category.click()]);
    await expect(notice).toBeVisible();
    await expect(page.getByTestId('review-highlights-none')).toBeVisible();
    await expect(page.getByTestId('phase-rail-fix')).toHaveCount(0);
    await expect(open).toBeDisabled();
  });
});
