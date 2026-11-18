/**
 * A market has two public addresses (T469): its own, `/<market>`, is the market page, for anyone,
 * and `/<market>/vendor` is the vendor's side. The map's old address and a door code on the
 * market's own address still land where they meant to. Proved on the app's own router.
 */
import { afterEach, describe, expect, it } from 'vitest';
import router from '@/router';
import { marketPagePath, vendorPagePath } from '@/utils/market';
import {
  marketPagePath as specsMarketPagePath,
  vendorPagePath as specsVendorPagePath,
} from '../../e2e/helpers/marketScreens';

const signIn = () =>
  localStorage.setItem('user', JSON.stringify({ email: 'organizer@example.com' }));

/** Where a visit to `path` lands, past every redirect and guard. */
async function landing(path: string) {
  await router.push(path);
  return router.currentRoute.value;
}

afterEach(async () => {
  localStorage.clear();
  await router.push('/login');
});

describe("a market's two addresses", () => {
  it("opens the market page at the market's own address", async () => {
    expect((await landing('/spring-market')).name).toBe('market-page');
  });

  it('opens the vendor page under it', async () => {
    const at = await landing('/spring-market/vendor');
    expect(at.name).toBe('vendor-page');
    expect(at.params.marketSlug).toBe('spring-market');
  });

  it("brings the map's old address to the market page, its day, location, table and hash with it", async () => {
    const at = await landing('/spring-market/map?date=d&location=l&table=t#h');
    expect(at.name).toBe('market-page');
    expect(at.path).toBe('/spring-market');
    expect(at.query).toEqual({ date: 'd', location: 'l', table: 't' });
    expect(at.hash).toBe('#h');
  });

  it("forwards a door code on the market's own address to the vendor page, holding the code", async () => {
    const at = await landing('/spring-market?door=C0DE');
    expect(at.name).toBe('vendor-page');
    expect(at.path).toBe('/spring-market/vendor');
    expect(at.query).toEqual({ door: 'C0DE' });
  });

  it.each(['/spring-market/vendor/anything', '/spring-market/apply', '/spring-market/check-in'])(
    'answers "Page not found" at %s',
    async (path) => {
      expect((await landing(path)).name).toBe('not-found');
    },
  );

  it.each(['market-page', 'vendor-page'])('makes %s public and a vendor-facing page', (name) => {
    const record = router.getRoutes().find((route) => route.name === name);
    expect(record?.meta).toEqual({ public: true, vendorFacing: true });
  });

  it('names no public map route any more', () => {
    expect(router.hasRoute('public-map')).toBe(false);
  });

  describe.each([
    ['signed out', () => {}],
    ['signed in', signIn],
  ])('%s', (_who, arrive) => {
    it.each([
      ['/spring-market', 'market-page'],
      ['/spring-market/vendor', 'vendor-page'],
    ])('lets %s through', async (path, name) => {
      arrive();
      const at = await landing(path);
      expect(at.name).toBe(name);
      expect(at.path).toBe(path);
    });
  });
});

describe("the builders of a market's two addresses", () => {
  it.each([
    ['the app', marketPagePath, vendorPagePath],
    ['the specs', specsMarketPagePath, specsVendorPagePath],
  ])('encode the slug, in %s', (_where, marketPage, vendorPage) => {
    expect(marketPage('spring-market')).toBe('/spring-market');
    expect(vendorPage('spring-market')).toBe('/spring-market/vendor');
    expect(marketPage('a b/c?d')).toBe('/a%20b%2Fc%3Fd');
    expect(vendorPage('a b/c?d')).toBe('/a%20b%2Fc%3Fd/vendor');
  });
});
