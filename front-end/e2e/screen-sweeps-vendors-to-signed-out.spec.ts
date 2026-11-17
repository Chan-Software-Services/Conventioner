import { sweepTheScreens } from './helpers/screenSweeps';

/**
 * The screen sweeps over a market's vendors, payments, door, layout and market days, an archive,
 * the markets of an account in no organization, and the signed-out pages: accessibility, contrast,
 * layout and focus, on one walk of the screens (`helpers/screenSweeps.ts` says what each check
 * holds).
 */
sweepTheScreens('from the vendors to the signed-out pages');
