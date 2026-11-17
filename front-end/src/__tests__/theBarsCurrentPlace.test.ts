import { afterEach, describe, expect, it } from 'vitest';
import router from '@/router';
import {
  currentPlace,
  isVendorFacing,
  marketPageAnswered,
  standsApart,
  vendorLinkFor,
  vendorPageAnswered,
} from '@/utils/currentPlace';
import { loadedRoute } from './support/loadedRoute';

/**
 * Which of the bar's two places a route stands in, read off the router's own routes, so a market
 * screen added tomorrow is covered by its `marketId` and nobody has to list it here.
 */
describe('which place is current', () => {
  const place = (path: string) => currentPlace(loadedRoute(router, path));

  it('is Markets on the list', () => {
    expect(place('/markets')).toBe('markets');
  });

  it.each([
    '/markets/m1',
    '/markets/m1/setup',
    '/markets/m1/form',
    '/markets/m1/applications',
    '/markets/m1/assignments',
    '/markets/m1/vendors',
    '/markets/m1/payments',
    '/markets/m1/attendance',
    '/markets/m1/tools',
    '/markets/m1/stats',
    '/markets/m1/import',
    '/markets/m1/start-from-csv',
    '/markets/m1/floorplan',
  ])('is Markets on the market screen %s', (path) => {
    expect(place(path)).toBe('markets');
  });

  it('is Organizations on Organizations', () => {
    expect(place('/organizations')).toBe('organizations');
  });

  it.each([
    '/login',
    '/reset-password-request',
    '/some-market',
    '/some-market/vendor',
    '/no/such/page',
  ])('is neither on %s', (path) => {
    expect(place(path)).toBeNull();
  });
});

/**
 * The market's two pages stand apart from the organizer app (T260, T469), and they alone: "Page not
 * found" does not.
 */
describe("which page is a vendor's", () => {
  it('is the vendor page', () => {
    expect(isVendorFacing(router.resolve('/some-market/vendor'))).toBe(true);
  });

  it("is the market page, the public map's place (T469)", () => {
    expect(isVendorFacing(router.resolve('/some-market'))).toBe(true);
  });

  it('is the market page and the vendor page, and no other route', () => {
    const vendorFacing = router
      .getRoutes()
      .filter((record) => record.meta.vendorFacing === true)
      .map((record) => String(record.name))
      .sort();
    expect(vendorFacing).toEqual(['market-page', 'vendor-page']);
  });

  it.each([
    '/markets',
    '/organizations',
    '/markets/m1/setup',
    '/login',
    '/reset-password-request',
    '/no/such/page',
  ])('is not %s', (path) => {
    expect(isVendorFacing(router.resolve(path))).toBe(false);
  });
});

/**
 * The market's two pages answer "Page not found" themselves for a slug naming no market or a gated
 * market's, and that is no vendor's page: the bar stands apart only while the page has not said so.
 */
describe('when the bar stands apart', () => {
  afterEach(() => {
    vendorPageAnswered('some-market', false);
    vendorPageAnswered('other-market', false);
  });

  it('does on a market page until it answers', () => {
    expect(standsApart(router.resolve('/some-market'))).toBe(true);
  });

  it('does on a market page that found its market', () => {
    vendorPageAnswered('some-market', false);
    expect(standsApart(router.resolve('/some-market'))).toBe(true);
  });

  it('does not on a market page that answered "Page not found"', () => {
    vendorPageAnswered('some-market', true);
    expect(standsApart(router.resolve('/some-market'))).toBe(false);
  });

  it('does on another slug\'s page than the one that answered "Page not found"', () => {
    vendorPageAnswered('some-market', true);
    expect(standsApart(router.resolve('/other-market'))).toBe(true);
  });

  it('does again once the page that answered "Page not found" finds its market', () => {
    vendorPageAnswered('some-market', true);
    vendorPageAnswered('some-market', false);
    expect(standsApart(router.resolve('/some-market'))).toBe(true);
  });

  it('does on a vendor page, and not once its read answered "Page not found" (T469)', () => {
    expect(standsApart(router.resolve('/some-market/vendor'))).toBe(true);
    vendorPageAnswered('some-market', true);
    expect(standsApart(router.resolve('/some-market/vendor'))).toBe(false);
  });

  it("is untouched by another slug's answer", () => {
    vendorPageAnswered('some-market', true);
    vendorPageAnswered('other-market', false);
    expect(standsApart(router.resolve('/some-market'))).toBe(false);
  });

  it.each(['/markets', '/markets/m1/setup', '/login', '/no/such/page'])(
    'does not on %s',
    (path) => {
      expect(standsApart(router.resolve(path))).toBe(false);
    },
  );
});

/**
 * The bar's way to the vendor's side (T469): on a market page that has answered found, and there
 * alone, it names the slug the link goes to and whether the tab is signed in for it, as the page
 * told it; anywhere else it names none.
 */
describe("the bar's link to the vendor page", () => {
  const link = (path: string) => vendorLinkFor(loadedRoute(router, path));

  afterEach(() => {
    marketPageAnswered('some-market', false);
    marketPageAnswered('other-market', false);
    vendorPageAnswered('some-market', false);
  });

  it('names none on a market page that has not answered', () => {
    expect(link('/some-market')).toBeNull();
  });

  it('names the slug once the market page answered found', () => {
    marketPageAnswered('some-market', true);
    expect(link('/some-market')).toEqual({ slug: 'some-market', signedIn: false });
  });

  it('says the tab is signed in for it when the page said so', () => {
    marketPageAnswered('some-market', true, true);
    expect(link('/some-market')).toEqual({ slug: 'some-market', signedIn: true });
  });

  it('takes the latest word on the sign-in from the page', () => {
    marketPageAnswered('some-market', true, true);
    marketPageAnswered('some-market', true, false);
    expect(link('/some-market')).toEqual({ slug: 'some-market', signedIn: false });
  });

  it('names none once the page takes its answer back', () => {
    marketPageAnswered('some-market', true, true);
    marketPageAnswered('some-market', false);
    expect(link('/some-market')).toBeNull();
  });

  it("names none on another slug's market page than the one that answered", () => {
    marketPageAnswered('some-market', true);
    expect(link('/other-market')).toBeNull();
  });

  it("is untouched by another slug's taking back", () => {
    marketPageAnswered('some-market', true, true);
    marketPageAnswered('other-market', false);
    expect(link('/some-market')).toEqual({ slug: 'some-market', signedIn: true });
  });

  it('names none once the page under it answered "Page not found", as a closing map does', () => {
    marketPageAnswered('some-market', true);
    vendorPageAnswered('some-market', true);
    expect(link('/some-market')).toBeNull();
  });

  it.each(['/some-market/vendor', '/markets', '/markets/m1/setup', '/login', '/no/such/page'])(
    'names none on %s',
    (path) => {
      marketPageAnswered('some-market', true);
      expect(link(path)).toBeNull();
    },
  );
});
