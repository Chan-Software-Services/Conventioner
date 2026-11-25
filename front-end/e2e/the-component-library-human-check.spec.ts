import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { eachWindow, expectLaidOut, openEntry } from './helpers/componentLibrary';
import { inTheWindow } from './helpers/phoneWindow';

/**
 * The component library's `human-check` entry (T539), at a desk and on a phone: `HumanCheck` above
 * a form's button with a key that passes unseen and one that asks for the tick, at a desk's sign-in
 * width and a 320-pixel phone's, and the two sentences a person is told.
 *
 * Cloudflare's script is played by a stand-in served at its address, so the spec measures this
 * app's layout and never depends on Cloudflare: a `3x` key draws a box of the size asked (flexible
 * 65px tall across the form, compact 150 by 140) and says it is asking for the tick; any other key
 * gives a token unseen, and a new one on each reset. The entry with Cloudflare's own script is
 * judged by eye in a builder's UI check.
 */

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const DIDNT_LOAD =
  "The check that you're a person didn't load. Check your connection, then reload the page.";
const NOT_CONFIRMED = "We couldn't confirm you're a person. Try again.";

const STAND_IN = `
window.turnstile = (() => {
  const widgets = new Map();
  const give = (options) => setTimeout(() => options.callback(${JSON.stringify(TOKEN)}));
  return {
    render(container, options) {
      const id = 'widget-' + (widgets.size + 1);
      widgets.set(id, options);
      if (options.sitekey.startsWith('3x')) {
        const box = document.createElement('div');
        box.dataset.size = options.size;
        box.style.width = options.size === 'compact' ? '150px' : '100%';
        box.style.height = options.size === 'compact' ? '140px' : '65px';
        box.style.background = '#fafafa';
        container.appendChild(box);
        setTimeout(() => options['before-interactive-callback']());
      } else {
        give(options);
      }
      return id;
    },
    reset(id) {
      const options = widgets.get(id);
      if (options && !options.sitekey.startsWith('3x')) give(options);
    },
    remove(id) {
      widgets.delete(id);
    },
  };
})();
`;

async function playCloudflare(page: Page) {
  await page.route(SCRIPT, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: STAND_IN }),
  );
}

const form = (page: Page, id: string) => page.getByTestId(`library-human-check-${id}`);

/** The check's box and the form's button, as they are drawn. */
async function checkAndButton(at: Locator) {
  const check = await at.getByTestId('human-check').boundingBox();
  const button = await at.getByRole('button', { name: 'Create account' }).boundingBox();
  return { check: check!, button: button! };
}

eachWindow('the human check entry', (size) => {
  const { press } = inTheWindow(size);

  test('names what it serves, and adds no room above the button while it passes unseen', async ({
    page,
    expectAccessible,
  }) => {
    await playCloudflare(page);
    await openEntry(page, 'human-check');
    await expect(page.getByTestId('library-serves')).toContainText('Organizer sign-up');

    for (const id of ['unseen-desk', 'unseen-phone']) {
      const at = form(page, id);
      await press(at.getByRole('button', { name: 'Create account' }));
      await expect(at.getByTestId('read-out')).toHaveText(`Got: a token, ${TOKEN}`);
      const { check, button } = await checkAndButton(at);
      expect(check.height, `${id}: the check takes no room`).toBe(0);
      expect(button.y, `${id}: the button sits where the check is`).toBeCloseTo(check.y, 1);
    }

    await expectLaidOut(page, size, 'the entry, passing unseen');
    await expectAccessible('the human check entry');
  });

  test("asks for the tick across a desk's form and compact on a phone's, 12px above the button", async ({
    page,
  }) => {
    await playCloudflare(page);
    await openEntry(page, 'human-check');

    for (const id of ['tick-desk', 'tick-phone']) {
      const at = form(page, id);
      const drawn = at.locator('[data-size]');
      await expect(drawn).toBeVisible();
      await expect(at.getByTestId('human-check')).toHaveClass(/human-check--drawn/);

      const { check, button } = await checkAndButton(at);
      const wide = check.width >= 300;
      await expect(drawn).toHaveAttribute('data-size', wide ? 'flexible' : 'compact');
      expect(check.height, `${id}: the check is as tall as the box drawn`).toBe(wide ? 65 : 140);
      expect(button.y - (check.y + check.height), `${id}: room above the button`).toBeCloseTo(
        12,
        1,
      );
    }
    // A 320-pixel phone's sign-in form is 224px wide: always compact.
    await expect(form(page, 'tick-phone').locator('[data-size]')).toHaveAttribute(
      'data-size',
      'compact',
    );
    if (!size.phone) {
      await expect(form(page, 'tick-desk').locator('[data-size]')).toHaveAttribute(
        'data-size',
        'flexible',
      );
    }

    await expectLaidOut(page, size, 'the entry, asking for the tick');
  });

  test("says the check didn't load when Cloudflare's script cannot be had", async ({ page }) => {
    await page.route(SCRIPT, (route) => route.abort('internetdisconnected'));
    await openEntry(page, 'human-check');

    const at = form(page, 'unseen-phone');
    await press(at.getByRole('button', { name: 'Create account' }));
    await expect(at.getByTestId('read-out')).toHaveText(`Got: ${DIDNT_LOAD}`);
    await expect(page.locator('[data-size]')).toHaveCount(0);
  });

  test('draws the two sentences a person is told, in the sign-in line', async ({ page }) => {
    await playCloudflare(page);
    await openEntry(page, 'human-check');

    await expect(page.getByTestId('library-human-check-didnt-load-error-message')).toHaveText(
      DIDNT_LOAD,
    );
    await expect(page.getByTestId('library-human-check-not-confirmed-error-message')).toHaveText(
      NOT_CONFIRMED,
    );
  });
});
