import crypto, { randomInt } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { loginViaApi, ensureTestOrgAuthenticated, marketNameToSlug } from './seeds';
import { decideReviewSetup } from './decideReviewSetup';
import { seedApplication } from './seedApplication';
import { mongoEval } from './mongo';
import { uniqueMarketName } from './uniqueName';
import { saveApplicationForm } from './saveApplicationForm';

/**
 * Seed result for a market that an applicant can log into.
 *
 * The market is published past `draft` and in the `applications` phase with a
 * configured application form. No applicant is seeded on it: a test that needs a known address
 * seeds one (`seedApplicationDoc`), on an address of its own (`anApplicantEmail`).
 */
export interface ApplicantMarketSeed {
  marketId: string;
  marketName: string;
  marketSlug: string;
  orgId: string;
}

/** Two fields typical of an application form - required, so a save that skipped
 *  validation would be noticeable. */
export const APPLICATION_FIELDS = [
  {
    key: 'business_name',
    label: 'Business Name',
    type: 'text',
    required: true,
    options: [],
    order: 0,
  },
  {
    key: 'product_type',
    label: 'What do you sell?',
    type: 'text',
    required: true,
    options: [],
    order: 1,
  },
];

/** The dates, sections and table types a seeded market plan offers. */
// Still to come, and Saturdays as the dates they replaced were (E31/F01/S01).
export const PLAN_DATES = ['2099-08-01', '2099-08-08', '2099-08-15'];
export const PLAN_SECTIONS = ['Main Hall', 'Garden'];
export const PLAN_TABLE_TYPES = ['Full Table', 'Half Table'];
export const PLAN_TIERS = ['Gold', 'Silver'];

/**
 * A market plan (camelCase `setupObject`) that offers the essential questions everything they
 * need: dates, sections, and a floorplan carrying table types - the same three sources the
 * back end derives the essential offering from.
 */
export function planSetupObject(dates: string[] = PLAN_DATES) {
  return {
    priority: [],
    marketDates: dates.map((date) => ({ date })),
    tiers: PLAN_TIERS.map((name, id) => ({ id, name })),
    locations: [{ name: 'Indoors' }],
    // Each tier has tables, which leaving draft asks for (E31/F01/S01).
    sections: PLAN_SECTIONS.map((name, index) => ({
      name,
      location: { name: 'Indoors' },
      tier: { id: index, name: PLAN_TIERS[index] },
      count: 4,
    })),
    assignmentOptions: {
      maxAssignmentsPerVendor: null,
      maxHalfTableProportionPerSection: null,
    },
    floorplans: [
      {
        tableTypes: PLAN_TABLE_TYPES.map((name) => ({
          name,
          widthMm: 1800,
          heightMm: 800,
          maxCapacity: 2,
        })),
      },
    ],
  };
}

/**
 * Create a published market in the `applications` phase with an application
 * form. A Google Form market (`intakeMode: 'csv'`) is left a draft, ready for
 * its first import, and so is one asked for as a `draft`, ready to be opened
 * from the rail.
 *
 * This is the minimum setup needed for the applicant login flow: the market
 * must be past `draft` so the public login endpoint can resolve it.
 *
 * @returns Metadata needed to navigate to the login page and reference the market.
 */
export async function seedApplicantMarket(
  request: APIRequestContext,
  baseURL: string,
  email: string,
  password: string,
  // `fields` are the form's own questions; absent, `APPLICATION_FIELDS`.
  options: {
    setupObject?: Record<string, unknown>;
    intakeMode?: 'csv' | 'form';
    fields?: Record<string, unknown>[];
    draft?: boolean;
    // A market's name is its public address, so a spec about an address names the market.
    name?: string;
    // Its review setup is decided (T206), a Google Form draft's too, unless a spec about the
    // decisions asks for them left undecided.
    reviewSetupUndecided?: boolean;
  } = {},
): Promise<ApplicantMarketSeed> {
  await loginViaApi(request, baseURL, email, password);
  const orgId = await ensureTestOrgAuthenticated(request, baseURL);

  const marketName = options.name ?? uniqueMarketName('E2E Applicant');
  const createRes = await request.post(`${baseURL}/markets`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      name: marketName,
      creationDate: new Date().toISOString(),
      organizationId: orgId,
      // This market's vendors apply through the public form, so it has to say so: intake mode
      // defaults to `csv`, which switches the applicant surface off entirely. A spec that wants
      // that switched-off market asks for `csv` here.
      intakeMode: options.intakeMode ?? 'form',
      // A market leaves draft only with a complete setup (E31/F01/S01), so one is always given.
      setupObject: options.setupObject ?? planSetupObject(),
    },
  });
  if (!createRes.ok()) {
    throw new Error(`Market creation failed: ${createRes.status()} ${await createRes.text()}`);
  }
  const { market_id: marketId } = (await createRes.json()) as { market_id: string };

  // Write the application form - this is what the guards check before
  // accepting a transition into `applications`.
  await saveApplicationForm(request, baseURL, marketId, {
    fields: options.fields ?? APPLICATION_FIELDS,
  });
  if (!options.reviewSetupUndecided) await decideReviewSetup(request, baseURL, marketId);

  // A Google Form market stays a draft, ready for its first import, which is its way into Review
  // (E38/F04/S01); a market whose vendors apply on its page opens applications.
  if ((options.intakeMode ?? 'form') === 'csv' || options.draft) {
    return { marketId, marketName, marketSlug: marketNameToSlug(marketName), orgId };
  }

  // Transition to applications - the guards require the form to exist.
  const transitionRes = await request.post(`${baseURL}/markets/${marketId}/transition`, {
    headers: { 'Content-Type': 'application/json' },
    data: { toPhase: 'applications' },
  });
  if (!transitionRes.ok()) {
    throw new Error(
      `Market transition failed: ${transitionRes.status()} ${await transitionRes.text()}`,
    );
  }

  return { marketId, marketName, marketSlug: marketNameToSlug(marketName), orgId };
}

/**
 * An applicant address no other test signs in on. The server takes at most five code requests and
 * ten code checks an address in fifteen minutes, counted across every market, so one address
 * shared by a file's tests, run again and again, is refused within a run (`sign_in_limits.py`).
 */
export function anApplicantEmail(prefix = 'applicant-e2e'): string {
  return `${prefix}-${Date.now()}${randomInt(1000, 10000)}@example.com`;
}

/**
 * Create an Application document for a market, straight into Mongo.
 *
 * An address with an Application on the market is one that has applied, so a
 * signed-in vendor reads their saved application, and a test of the
 * anti-oracle can ask for a code for a known address beside a stranger's.
 */
export function seedApplicationDoc(marketId: string, applicantEmail: string): string {
  return seedApplication(marketId, applicantEmail, {});
}

/**
 * Create a login challenge in `applicant_login_challenges` with a known
 * plaintext code.
 *
 * The back end stores codes as salted SHA-256 hashes (`salt:digest`), so the
 * test cannot read a code out of MongoDB after requesting one. This helper
 * writes the challenge as a request does, with the correct hash for a known
 * code: unconsumed, no tries yet (`attempts`), ten minutes to run, and the
 * code's number (`sequence`) kept from the request it stands in for, or 1.
 *
 * Call it AFTER requesting a code through the UI or the API, which stores a
 * random code of its own: this replaces that code with the known one, as the
 * email the stack does not send would have carried it.
 *
 * `attempts` plants a code with that many of its five tries already used, so a
 * screen reaches a used-up code with one wrong try rather than five.
 */
export function createApplicantLoginChallenge(
  marketId: string,
  email: string,
  code: string,
  { attempts = 0 }: { attempts?: number } = {},
): void {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  const codeHash = `${salt}:${hash}`;
  const emailLower = email.toLowerCase();
  const expiryTs = Date.now() + 600_000;
  const createdAt = new Date().toISOString();

  const evalJs = [
    `db.applicant_login_challenges.updateOne(`,
    `  { market_id: ${JSON.stringify(marketId)}, email: ${JSON.stringify(emailLower)} },`,
    `  {`,
    `    $set: {`,
    `      code_hash: ${JSON.stringify(codeHash)},`,
    `      consumed: false,`,
    `      attempts: ${attempts},`,
    `      expires_at: new Date(${expiryTs}),`,
    `      created_at: ${JSON.stringify(createdAt)}`,
    `    },`,
    `    $setOnInsert: { sequence: 1 }`,
    `  },`,
    `  { upsert: true }`,
    `)`,
  ].join('\n');

  mongoEval(evalJs);
}
