import { test, expect } from './fixtures';
import { sweepTheScreens } from './helpers/screenSweeps';

/**
 * The screen sweeps over the organizer's markets and organizations, and a market from its draft to
 * its assignments: accessibility, contrast, layout and focus, on one walk of the screens
 * (`helpers/screenSweeps.ts` says what each check holds).
 */
sweepTheScreens('from the markets list to the assignments');

test.describe('Focus shows on controls only, as a green border or the soft halo', () => {
  // AppDialog focuses its window when no control is ready to take focus, as Manage market's is
  // not while its market loads; the browser drew its own ring around the whole window.
  test('a dialog opened from the keyboard draws no ring around its window', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/markets');
    const manage = page.getByTestId('market-card-manage-button').first();
    await manage.waitFor();
    await manage.focus();
    await page.keyboard.press('Enter');
    const win = page.getByTestId('manage-market-window');
    await expect(win).toBeFocused();
    expect(await win.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    await expect(win).toHaveCSS('outline-style', 'none');
  });
});
