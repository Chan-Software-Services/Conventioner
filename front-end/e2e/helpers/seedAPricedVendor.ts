import { expect, type APIRequestContext } from '@playwright/test';
import { SEED_MARKET_DATE, seedMarketWithVendors } from './seeds';
import { savePlan } from './savePlan';
import { mongoEval } from './mongo';

export const PRICED_VENDOR = 'alice@example.com';

const GOLD = { id: 1, name: 'Gold' };

const PLAN = {
  priority: [],
  marketDates: [{ date: SEED_MARKET_DATE }],
  tiers: [GOLD],
  locations: [{ name: 'Main Hall' }],
  sections: [{ name: 'North Wing', location: { name: 'Main Hall' }, tier: GOLD, count: 2 }],
  assignmentOptions: { maxAssignmentsPerVendor: 1, maxHalfTableProportionPerSection: 50 },
  pricing: { currency: 'CAD', halfTablePercent: 50, everyoneElse: [{ tier: 'Gold', cents: 3500 }] },
};

async function call(
  request: APIRequestContext,
  method: 'put' | 'post',
  path: string,
  data: object,
) {
  const res = await request[method](path, { data });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
}

/**
 * A priced market (CAD, a Gold full table at $35) in assignment, with alice on a Gold full table
 * on its one date: her drawer's Payment tab owes $35 and records a payment. Returns the market's
 * id; `request` is signed in as the market's owner by `seedMarketWithVendors`.
 */
export async function seedAPricedVendor(
  request: APIRequestContext,
  baseURL: string,
  email: string,
  password: string,
): Promise<string> {
  const { marketId } = await seedMarketWithVendors(request, baseURL, email, password);
  mongoEval(
    `db.applications.updateMany({ market_id: ${JSON.stringify(marketId)} },
      { $set: { 'form_data.essential_section_ranking': ['North Wing'] } })`,
  );
  await savePlan(request, baseURL, email, marketId, PLAN);
  for (const toPhase of ['applications', 'assignment']) {
    await call(request, 'post', `${baseURL}/markets/${marketId}/transition`, { toPhase });
  }
  await call(request, 'put', `${baseURL}/markets/${marketId}/placements`, {
    email: PRICED_VENDOR,
    date: SEED_MARKET_DATE,
    table_code: 'North Wing 1',
    table_choice: 'Full Table',
  });
  return marketId;
}
