import { test, expect, TEST_USER, BACKEND_URL } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { SEED_MARKET_DATE, seedMarketWithVendors } from './helpers/seeds';
import { savePlan } from './helpers/savePlan';
import { ensureVerifiedUser } from './helpers/verifiedUser';
import { grantMarketRole } from './helpers/grantMarketRole';
import { withUser } from './helpers/withUser';
import { marketScreenPath } from './helpers/marketScreens';
import { mongoEval } from './helpers/mongo';

/**
 * The drawer's Payment tab (E44/F01/S01).
 *
 * A line per table-day with what is owed for it, the payments an Editor records, and how the two
 * compare. Freeing a table keeps its line, still owed, and changes neither amount (Q26); a Viewer
 * reads the tab and records nothing.
 */
const EDITOR = { email: 'e2e-payment-editor@example.com', password: 'e2epassword123' };
const VIEWER = { email: 'e2e-payment-viewer@example.com', password: 'e2epassword123' };
const SECOND_DATE = '2099-05-08';
const GOLD = { id: 1, name: 'Gold' };
const SILVER = { id: 2, name: 'Silver' };
const ALICE = 'alice@example.com';

const PLAN = {
  priority: [],
  marketDates: [{ date: SEED_MARKET_DATE }, { date: SECOND_DATE }],
  tiers: [GOLD, SILVER],
  locations: [{ name: 'Main Hall' }],
  sections: [
    { name: 'North Wing', location: { name: 'Main Hall' }, tier: GOLD, count: 2 },
    { name: 'Landing', location: { name: 'Main Hall' }, tier: SILVER, count: 2 },
  ],
  assignmentOptions: { maxAssignmentsPerVendor: 2, maxHalfTableProportionPerSection: 50 },
  pricing: {
    currency: 'CAD',
    halfTablePercent: 50,
    everyoneElse: [
      { tier: 'Gold', cents: 3500 },
      { tier: 'Silver', cents: 3000 },
    ],
  },
};

async function call(
  request: APIRequestContext,
  method: 'put' | 'post' | 'delete',
  path: string,
  data: Record<string, unknown>,
) {
  const res = await request[method](`${BACKEND_URL}${path}`, { data });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
}

/** A priced market in assignment, Alice on a Gold full table on both of its days. */
async function aliceOnTwoGoldDays(request: APIRequestContext): Promise<string> {
  const seed = await seedMarketWithVendors(
    request,
    BACKEND_URL,
    TEST_USER.email,
    TEST_USER.password,
    { dates: [SEED_MARKET_DATE, SECOND_DATE] },
  );
  const marketId = seed.marketId;
  mongoEval(
    `db.applications.updateMany({ market_id: ${JSON.stringify(marketId)} },
      { $set: { 'form_data.essential_section_ranking': ['North Wing', 'Landing'] } })`,
  );
  await savePlan(request, BACKEND_URL, TEST_USER.email, marketId, PLAN);
  for (const [person, role] of [
    [EDITOR, 'editor'],
    [VIEWER, 'viewer'],
  ] as const) {
    await grantMarketRole(request, marketId, person, role);
  }
  for (const toPhase of ['applications', 'assignment']) {
    await call(request, 'post', `/markets/${marketId}/transition`, { toPhase });
  }
  for (const date of [SEED_MARKET_DATE, SECOND_DATE]) {
    await call(request, 'put', `/markets/${marketId}/placements`, {
      email: ALICE,
      date,
      table_code: 'North Wing 1',
      table_choice: 'Full Table',
    });
  }
  return marketId;
}

/** Alice's drawer, open on its Payment tab. */
async function paymentTab(page: Page, marketId: string) {
  const query = new URLSearchParams({ vendor: ALICE, vendorTab: 'payment' });
  await page.goto(`${marketScreenPath(marketId, 'vendors')}?${query.toString()}`);
  const tab = page.getByTestId('payment-tab');
  await expect(tab).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('tab', { name: 'Payment' })).toHaveAttribute('aria-selected', 'true');
  return tab;
}

/** Record a payment, paid today unless `paidOn` (YYYY-MM-DD) names another day. */
async function recordPayment(
  page: Page,
  amount: string,
  method: 'e-transfer' | 'cash',
  paidOn?: string,
) {
  await page.getByTestId('payment-record').click();
  const dialog = page.getByTestId('record-payment-window');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Amount (CAD)').fill(amount);
  if (paidOn) await dialog.getByTestId('record-payment-date').fill(paidOn);
  await dialog.getByLabel(method === 'cash' ? 'Cash' : 'E-transfer').check();
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(dialog).toBeHidden();
}

test.describe('the Payment tab', () => {
  test.beforeAll(() => {
    ensureVerifiedUser(EDITOR.email, EDITOR.password);
    ensureVerifiedUser(VIEWER.email, VIEWER.password);
  });

  test('two Gold full days owe $70, and two payments of $35 pay it in full', async ({
    browser,
    request,
  }) => {
    const marketId = await aliceOnTwoGoldDays(request);

    await withUser(browser, EDITOR.email, EDITOR.password, async (page) => {
      const tab = await paymentTab(page, marketId);
      const lines = tab.getByTestId('payment-line');
      await expect(lines).toHaveCount(2);
      await expect(lines.nth(0)).toContainText('North Wing 1, Gold, full table');
      await expect(lines.nth(0).getByTestId('payment-line-owed')).toHaveText('$35.00');
      await expect(tab.getByTestId('payment-owed')).toHaveText('$70.00');
      await expect(tab.getByTestId('payment-paid')).toHaveText('$0.00');
      await expect(tab.getByTestId('payment-balance')).toHaveText('Owes $70.00');

      await recordPayment(page, '35', 'e-transfer');
      await expect(tab.getByTestId('payment-balance')).toHaveText('Owes $35.00');
      await expect(tab.getByTestId('payment-paid')).toHaveText('$35.00');

      await recordPayment(page, '35', 'cash');
      await expect(tab.getByTestId('payment-balance')).toHaveText('Paid in full');
      const entries = tab.getByTestId('payment-entry');
      await expect(entries).toHaveCount(2);
      await expect(entries.nth(0)).toContainText('Cash, paid');
      await expect(entries.nth(0).getByTestId('payment-entry-who')).toContainText(
        `Recorded by ${EDITOR.email}`,
      );

      // A reload reads what the server kept.
      await page.reload();
      await expect(page.getByTestId('payment-balance')).toHaveText('Paid in full', {
        timeout: 15000,
      });
    });

    // Freeing a paid day keeps its line, still owed, and changes neither amount (Q26).
    await call(request, 'delete', `/markets/${marketId}/placements`, {
      email: ALICE,
      date: SECOND_DATE,
    });
    await withUser(browser, EDITOR.email, EDITOR.password, async (page) => {
      const tab = await paymentTab(page, marketId);
      const lines = tab.getByTestId('payment-line');
      await expect(lines).toHaveCount(2);
      // The line says where its number came from: the seat, freed, and when.
      await expect(lines.nth(1).getByTestId('payment-line-source')).toHaveText(
        /^North Wing 1, Gold, full table - table freed [A-Z][a-z]{2} \d{1,2}, \d{4}$/,
      );
      await expect(lines.nth(1).getByTestId('payment-line-owed')).toHaveText('$35.00');
      await expect(tab.getByTestId('payment-owed')).toHaveText('$70.00');
      await expect(tab.getByTestId('payment-balance')).toHaveText('Paid in full');
    });
  });

  test('the amount reads as currency once left, and the plain number while focused', async ({
    browser,
    request,
  }) => {
    const marketId = await aliceOnTwoGoldDays(request);

    await withUser(browser, EDITOR.email, EDITOR.password, async (page) => {
      const tab = await paymentTab(page, marketId);
      await page.getByTestId('payment-record').click();
      const dialog = page.getByTestId('record-payment-window');
      const amount = dialog.getByLabel('Amount (CAD)');
      await expect(amount).toBeFocused();

      // Typed as a person types it: the text stays as typed until the field is left.
      await amount.pressSequentially('35');
      await expect(amount).toHaveValue('35');
      await page.keyboard.press('Tab');
      await expect(amount).toHaveValue('$35.00');
      await page.keyboard.press('Shift+Tab');
      await expect(amount).toBeFocused();
      await expect(amount).toHaveValue('35.00');
      expect(
        await amount.evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      ).toEqual([5, 5]);

      // Text that is no amount keeps what was typed and its error, and Record stays disabled.
      await amount.fill('3x');
      await page.keyboard.press('Tab');
      await expect(amount).toHaveValue('3x');
      await expect(dialog.getByTestId('record-payment-amount-error')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Record payment' })).toBeDisabled();

      await amount.focus();
      await amount.fill('35');
      await page.keyboard.press('Tab');
      await expect(amount).toHaveValue('$35.00');
      await dialog.getByRole('button', { name: 'Record payment' }).click();
      await expect(dialog).toBeHidden();
      await expect(tab.getByTestId('payment-paid')).toHaveText('$35.00');
      await expect(tab.getByTestId('payment-balance')).toHaveText('Owes $35.00');
    });
  });

  test('its dialogs open centred on the window, with the drawer held behind them', async ({
    authenticatedPage: page,
    request,
  }) => {
    const marketId = await aliceOnTwoGoldDays(request);
    const tab = await paymentTab(page, marketId);
    // An entry, so the entry menu's Remove has something to confirm.
    await recordPayment(page, '35', 'cash');
    const drawer = page.getByTestId('vendors-detail-panel');
    const line = tab.getByTestId('payment-line').first();
    const entry = tab.getByTestId('payment-entry').first();

    /** Each dialog the tab opens, how it is opened, and the control focus goes back to. */
    const dialogs = [
      {
        name: 'Record payment',
        testid: 'record-payment',
        anchored: true,
        opener: page.getByTestId('payment-record'),
        open: () => page.getByTestId('payment-record').click(),
      },
      {
        name: 'Change owed',
        testid: 'change-owed',
        anchored: true,
        opener: line.getByTestId('payment-line-menu-button'),
        open: async () => {
          await line.getByTestId('payment-line-menu-button').click();
          await line.getByTestId('payment-line-menu-owed').click();
        },
      },
      {
        name: "the entry menu's Remove",
        testid: 'payment-confirm',
        anchored: false,
        opener: entry.getByTestId('payment-entry-menu-button'),
        open: async () => {
          await entry.getByTestId('payment-entry-menu-button').click();
          await entry.getByTestId('payment-entry-menu-remove').click();
        },
      },
    ];

    for (const size of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      for (const dialog of dialogs) {
        const at = `${dialog.name} at ${size.width}`;
        await dialog.open();
        const window = page.getByTestId(`${dialog.testid}-window`);
        await expect(window, `${at} opens`).toBeVisible();
        // Its window centred across the browser's window, not the drawer it was opened from. The
        // window is the box a fixed element is laid out in, measured by one, since headless
        // Chromium's scroll bar gutter takes 15px from it that `clientWidth` still counts.
        const box = (await window.boundingBox())!;
        const area = await page.evaluate(() => {
          const probe = document.createElement('div');
          probe.style.cssText = 'position: fixed; inset: 0; visibility: hidden';
          document.body.append(probe);
          const { width, height } = probe.getBoundingClientRect();
          probe.remove();
          return { width, height };
        });
        expect(Math.abs(box.x + box.width / 2 - area.width / 2), `${at}: across`).toBeLessThan(1);
        // Down, a dialog whose body grows as it is filled holds its top 48px below the window's;
        // the rest are centred.
        if (dialog.anchored) expect(Math.abs(box.y - 48), `${at}: its top`).toBeLessThan(1);
        else
          expect(Math.abs(box.y + box.height / 2 - area.height / 2), `${at}: down`).toBeLessThan(1);
        // The drawer stays behind it, out of reach.
        expect(
          await drawer.evaluate((el) => !!el.closest('[inert]')),
          `${at}: the drawer is inert`,
        ).toBe(true);

        // Escape closes the dialog alone, and focus goes back to what opened it.
        await page.keyboard.press('Escape');
        await expect(window, `${at} closes`).toBeHidden();
        await expect(drawer, `${at}: the drawer stays open`).toBeVisible();
        expect(
          await drawer.evaluate((el) => !!el.closest('[inert]')),
          `${at}: the drawer is handed back`,
        ).toBe(false);
        await expect(dialog.opener, `${at}: focus goes back`).toBeFocused();
      }
    }
  });

  test('sets its parts apart: each a card, each table-day and payment a box, even alone', async ({
    authenticatedPage: page,
    request,
  }) => {
    const marketId = await aliceOnTwoGoldDays(request);
    const tab = await paymentTab(page, marketId);
    // One payment, alone in its list, beside two table-days, on a day whose name is too long to
    // stand after "E-transfer, paid" at a desk: "Wednesday, September 30, 2099".
    await recordPayment(page, '35', 'e-transfer', '2099-09-30');
    await expect(tab.getByTestId('payment-entry')).toHaveCount(1);

    const cards = ['payment-totals', 'payment-days', 'payment-payments'].map((id) =>
      tab.getByTestId(id),
    );
    const boxes = [
      ...(await tab.getByTestId('payment-line').all()).map((box) => ({
        box,
        menu: box.getByTestId('payment-line-menu-button'),
      })),
      ...(await tab.getByTestId('payment-entry').all()).map((box) => ({
        box,
        menu: box.getByTestId('payment-entry-menu-button'),
      })),
    ];
    expect(boxes).toHaveLength(3);

    /** Its edge on all four sides, its corners, its inset, and where it stands on the page. */
    const drawn = (target: typeof tab) =>
      target.evaluate((el) => {
        const style = getComputedStyle(el);
        const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
        const rect = el.getBoundingClientRect();
        return {
          edges: sides.map(
            (side) =>
              `${style.getPropertyValue(`border-${side.toLowerCase()}-width`)} ${style.getPropertyValue(`border-${side.toLowerCase()}-style`)}`,
          ),
          corners: style.borderRadius,
          inset: style.padding,
          rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        };
      });
    const EDGES = ['1px solid', '1px solid', '1px solid', '1px solid'];
    /** How many lines its words take: the distinct bottoms of its text's own boxes. */
    const linesOf = (el: Element) => {
      const bottoms = new Set<number>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects())
          if (rect.width > 0) bottoms.add(Math.round(rect.bottom));
      }
      return bottoms.size;
    };

    // 1440 and 390 are the final design's; at 375 and 320 a box too narrow for its words beside
    // its amount puts the amount and "..." under the words.
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 375, height: 667 },
      { width: 320, height: 700 },
    ]) {
      await page.setViewportSize(size);
      const at = `at ${size.width}`;
      const tabRect = (await drawn(tab)).rect;

      const cardsDrawn = [];
      for (const card of cards) cardsDrawn.push(await drawn(card));
      for (const [i, card] of cardsDrawn.entries()) {
        expect(card.edges, `card ${i} ${at}: its edge`).toEqual(EDGES);
        expect(card.corners, `card ${i} ${at}: its corners`).toBe('10px');
        expect(card.inset, `card ${i} ${at}: its inset`).toBe('16px');
        // Nothing runs past the tab, the drawer's column, on a phone or at a desk.
        expect(card.rect.left, `card ${i} ${at}: its left`).toBeGreaterThanOrEqual(tabRect.left);
        expect(card.rect.right, `card ${i} ${at}: its right`).toBeLessThanOrEqual(tabRect.right);
        if (i > 0)
          expect(
            card.rect.top - cardsDrawn[i - 1].rect.bottom,
            `card ${i} ${at}: apart`,
          ).toBeCloseTo(16, 1);
      }

      // "Record refund" and "Record payment" keep one row inside their card, under the heading
      // where the card is too narrow for all three; narrower than 390 the card may be too narrow
      // for the two side by side, and they stand one over the other, still inside it.
      const refund = (await drawn(tab.getByTestId('payment-refund'))).rect;
      const record = (await drawn(tab.getByTestId('payment-record'))).rect;
      if (size.width >= 390)
        expect(Math.abs(refund.top - record.top), `the buttons ${at}: one row`).toBeLessThan(1);
      for (const [name, button] of [
        ['refund', refund],
        ['record', record],
      ] as const) {
        expect(button.left, `${name} ${at}: inside its card`).toBeGreaterThanOrEqual(
          cardsDrawn[2].rect.left + 17 - 0.5,
        );
        expect(button.right, `${name} ${at}: inside its card`).toBeLessThanOrEqual(
          cardsDrawn[2].rect.right - 17 + 0.5,
        );
      }

      // A table-day's date and a payment's paid day break, where they must, only after the
      // weekday: "November 17, 2026" keeps one line, its day number never torn from its month.
      const dates = await tab.getByTestId(/^payment-(line|entry)-day$/).all();
      expect(dates).toHaveLength(3);
      for (const [i, day] of dates.entries()) {
        expect(await day.evaluate(linesOf), `day ${i} ${at}: one line`).toBe(1);
      }

      // At a desk each whole date, its weekday too, keeps one line of its own: "E-transfer, paid"
      // then "Tuesday, November 10, 2026", never "Tuesday," left behind.
      const wholeDates = await tab.getByTestId(/^payment-(line|entry)-date$/).all();
      expect(wholeDates).toHaveLength(3);
      if (size.width >= 1440)
        for (const [i, date] of wholeDates.entries())
          expect(await date.evaluate(linesOf), `date ${i} ${at}: one line`).toBe(1);

      const boxesDrawn = [];
      for (const { box, menu } of boxes) {
        const drawnBox = await drawn(box);
        const menuRect = (await drawn(menu)).rect;
        // Its date and words, its amount and its "..." each have room of their own.
        const parts = [
          (await drawn(box.getByTestId(/^payment-(line|entry)-main$/))).rect,
          (await drawn(box.getByTestId(/^payment-(line|entry)-amounts$/))).rect,
          menuRect,
        ];
        for (const [a, b] of [
          [0, 1],
          [0, 2],
          [1, 2],
        ]) {
          const apart =
            parts[a].right <= parts[b].left + 0.5 ||
            parts[b].right <= parts[a].left + 0.5 ||
            parts[a].bottom <= parts[b].top + 0.5 ||
            parts[b].bottom <= parts[a].top + 0.5;
          expect(apart, `box ${boxesDrawn.length} ${at}: parts ${a} and ${b} apart`).toBe(true);
        }
        // And nothing in it reaches past the date's column into the amount.
        const reach = await box
          .getByTestId(/^payment-(line|entry)-main$/)
          .evaluate((el) =>
            Math.max(...[...el.querySelectorAll('*')].map((c) => c.getBoundingClientRect().right)),
          );
        expect(
          reach,
          `box ${boxesDrawn.length} ${at}: its words stay in their column`,
        ).toBeLessThanOrEqual(parts[0].right + 0.5);
        boxesDrawn.push(drawnBox);
        const i = boxesDrawn.length - 1;
        expect(drawnBox.edges, `box ${i} ${at}: its edge`).toEqual(EDGES);
        expect(drawnBox.corners, `box ${i} ${at}: its corners`).toBe('6px');
        expect(drawnBox.inset, `box ${i} ${at}: its inset`).toBe('8px 12px');
        // Its "..." sits inside it.
        for (const side of ['top', 'left'] as const)
          expect(menuRect[side], `box ${i} ${at}: its menu's ${side}`).toBeGreaterThan(
            drawnBox.rect[side],
          );
        for (const side of ['bottom', 'right'] as const)
          expect(menuRect[side], `box ${i} ${at}: its menu's ${side}`).toBeLessThan(
            drawnBox.rect[side],
          );
        // At the box's end, its amount beside it, wherever the box puts the two.
        expect(
          drawnBox.rect.right - menuRect.right,
          `box ${i} ${at}: its menu at its end`,
        ).toBeCloseTo(13, 1);
        // A phone's "..." is a thumb's 44px, beside an amount one text line tall (base.css).
        expect(menuRect.bottom - menuRect.top, `box ${i} ${at}: its menu's height`).toBeCloseTo(
          size.width <= 640 ? 44 : 24,
          1,
        );
        const amounts = parts[1];
        expect(
          menuRect.left - amounts.right,
          `box ${i} ${at}: its amount beside its menu`,
        ).toBeCloseTo(16, 1);
        expect(
          Math.abs((amounts.top + amounts.bottom) / 2 - (menuRect.top + menuRect.bottom) / 2),
          `box ${i} ${at}: its amount on its menu's midline`,
        ).toBeLessThanOrEqual(1);
      }
      // The two table-days stand a box's gap apart, inside their card's inset.
      expect(
        boxesDrawn[1].rect.top - boxesDrawn[0].rect.bottom,
        `the days ${at}: apart`,
      ).toBeCloseTo(8, 1);
      const days = cardsDrawn[1].rect;
      const payments = cardsDrawn[2].rect;
      for (const [i, box] of boxesDrawn.entries()) {
        const card = i < 2 ? days : payments;
        expect(box.rect.left - card.left, `box ${i} ${at}: inset from its card`).toBeCloseTo(17, 1);
        expect(card.right - box.rect.right, `box ${i} ${at}: inset from its card`).toBeCloseTo(
          17,
          1,
        );
      }
    }
  });

  test('a Viewer reads the tab and is offered no Record payment', async ({ browser, request }) => {
    const marketId = await aliceOnTwoGoldDays(request);

    await withUser(browser, VIEWER.email, VIEWER.password, async (page) => {
      const tab = await paymentTab(page, marketId);
      await expect(tab.getByTestId('payment-owed')).toHaveText('$70.00');
      await expect(tab.getByText('No payments recorded.')).toBeVisible();
      await expect(page.getByTestId('payment-record')).toHaveCount(0);
    });
  });
});
