import type { APIRequestContext } from '@playwright/test';
import { decideReviewSetup } from './decideReviewSetup';
import { saveApplicationForm } from './saveApplicationForm';
import { approvedVendorApplication, insertApplications } from './seedApplication';
import {
  allocateThenFreeEverySeat,
  ensureTestOrgAuthenticated,
  loginViaApi,
  marketNameToSlug,
  publishResults,
  SECOND_FLOORPLAN_PATH,
  startLayout,
} from './seeds';
import { uniqueMarketName } from './uniqueName';
import { calendarToday } from './vendorSignIn';

/** What `seedMarketDayMap` seeded, for a spec to assert against. */
export interface SeededMarketDayMap {
  marketId: string;
  marketName: string;
  slug: string;
  orgId: string;
  /** Today and tomorrow, as calendar days where the browser is, reckoned from `seededAt`. */
  today: string;
  tomorrow: string;
  /**
   * The one instant `today` and `tomorrow` were reckoned from, at which a spec holds its pages'
   * clock (`page.clock.setFixedTime`) so they open on `today` whatever the clock reads by then.
   */
  seededAt: Date;
  north: typeof NORTH_WING;
  south: typeof SOUTH_WING;
  /** Every vendor seeded, in the order of `DAY_MAP_VENDORS`. */
  vendors: DayMapVendor[];
  /** The vendor checked in today; nobody is, `inAssignment`. */
  checkedIn: DayMapVendor;
  /** The texts no public page may ever show: names, addresses, the note. */
  personalMarkers: string[];
}

export const NORTH_WING = { id: 'loc-north-wing', name: 'North Wing' };
export const SOUTH_WING = { id: 'loc-south-wing', name: 'South Wing' };
export const AISLE_A = { id: 'sec-aisle-a', name: 'Aisle A' };
export const AISLE_B = { id: 'sec-aisle-b', name: 'Aisle B' };

/** The form's three short text questions the public map reads, and their keys. */
export const DAY_MAP_QUESTIONS = {
  name: { key: 'business_name', label: 'Business name' },
  website: { key: 'website', label: 'Website' },
  instagram: { key: 'instagram_handle', label: 'Instagram handle' },
};

export interface DayMapVendor {
  email: string;
  fullName: string;
  preferredName: string;
  /** What they answered to the three questions, as typed; absent when they answered none. */
  answers: { businessName?: string; website?: string; instagram?: string };
  /** Their seat today, and tomorrow when they have one. */
  today: { tableCode: string; tableChoice: string; location: string };
  tomorrow?: { tableCode: string; tableChoice: string; location: string };
}

const FULL = 'Full Table';
const LEFT = 'Half Table (Left)';
const RIGHT = 'Half Table (Right)';
const north = (code: string, tableChoice = FULL) => ({
  tableCode: code,
  tableChoice,
  location: NORTH_WING.name,
});
const south = (code: string) => ({ tableCode: code, tableChoice: FULL, location: SOUTH_WING.name });

export const DAY_MAP_VENDORS: DayMapVendor[] = [
  {
    email: 'wren@ember-ceramics.test',
    fullName: 'Wrenfixture Okonkwo',
    preferredName: 'Wrenpref',
    answers: {
      businessName: 'Ember Ceramics',
      website: 'ember-ceramics.test',
      instagram: '@example_ember',
    },
    today: north('Aisle A 1'),
    tomorrow: north('Aisle A 2'),
  },
  {
    email: 'ines@kiln-and-co.test',
    fullName: 'Inesfixture Halvorsen',
    preferredName: 'Inespref',
    answers: {
      businessName: 'Kiln & Co',
      website: 'https://kiln-and-co.test/shop',
      instagram: 'https://www.instagram.com/example_kiln/',
    },
    today: north('Aisle A 2'),
  },
  {
    email: 'tamsin@loom-house.test',
    fullName: 'Tamsinfixture Achebe',
    preferredName: 'Tamsinpref',
    answers: { businessName: 'Loom House', instagram: 'example_loom' },
    today: north('Aisle A 3', LEFT),
    tomorrow: north('Aisle A 1'),
  },
  {
    email: 'oskar@paper-moth.test',
    fullName: 'Oskarfixture Lindqvist',
    preferredName: 'Oskarpref',
    answers: { businessName: 'Paper Moth Press', website: 'paper-moth.test' },
    today: north('Aisle A 3', RIGHT),
  },
  {
    // Answered none of the three: a taken table with no details.
    email: 'priya@no-answers.test',
    fullName: 'Priyafixture Raman',
    preferredName: 'Priyapref',
    answers: {},
    today: south('Aisle B 1'),
  },
  {
    // An email address as the business name, which the map withholds.
    email: 'lu@sweet-thread.test',
    fullName: 'Lufixture Moreau',
    preferredName: 'Lupref',
    answers: {
      businessName: 'orders@sweet-thread.test',
      website: 'sweet-thread.test',
      instagram: '@example_thread',
    },
    today: south('Aisle B 2'),
  },
  {
    email: 'femi@salt-and-sage.test',
    fullName: 'Femifixture Adeyemi',
    preferredName: 'Femipref',
    answers: {
      businessName: 'Salt & Sage',
      website: 'https://salt-and-sage.test',
      instagram: 'example_sage',
    },
    today: south('Aisle B 3'),
  },
];

const NOTE = 'Notefixture: brings a canopy of their own';

async function ok(response: Awaited<ReturnType<APIRequestContext['get']>>, what: string) {
  if (!response.ok())
    throw new Error(`${what} failed: ${response.status()} ${await response.text()}`);
}

/**
 * A market on its market days with a map to draw (T422): every later ticket of the day map, the
 * public page and Attendance's map, starts from it.
 *
 * A `form` market in Market Days, today its first date and tomorrow its second, with two locations
 * each laid out in Draft: North Wing, its Aisle A of four tables in a row and a stage turned 30
 * degrees, and South Wing, its Aisle B of three, on another floorplan image than North Wing's.
 * Seven vendors hold today's seats, two of them sharing Aisle A 3 as its left and right halves, and
 * one checked in at the door; tomorrow two vendors are seated. The form's three short text questions, a business name, a website and an
 * Instagram handle, are answered by most vendors, one answering none and one giving an email
 * address as their business name, which the map withholds. Each vendor's full name, preferred name
 * and the organizer's note on one are the personal markers a spec of the public map looks for and
 * must never find.
 *
 * With `publicMap`, the map is turned on too, through the Public map card's own write, its three
 * questions chosen. With `inAssignment`, it stops in Assignment once the seats are given, with no
 * location laid out, its results not out and nobody checked in, so a spec starts a layout past
 * Draft and publishes itself. Every value is a fixture value.
 */
export async function seedMarketDayMap(
  request: APIRequestContext,
  baseURL: string,
  email: string,
  password: string,
  options: { publicMap?: boolean; name?: string; inAssignment?: boolean } = {},
): Promise<SeededMarketDayMap> {
  // One read of the clock: two reads straddling midnight would give days D and D+2.
  const seededAt = new Date();
  const today = calendarToday(seededAt);
  // The next day on the calendar, not 24 hours on, which a day of 23 or 25 hours would miss.
  const tomorrow = calendarToday(
    new Date(seededAt.getFullYear(), seededAt.getMonth(), seededAt.getDate() + 1),
  );
  await loginViaApi(request, baseURL, email, password);
  const orgId = await ensureTestOrgAuthenticated(request, baseURL);
  const marketName = options.name ?? uniqueMarketName('Day Map Market');
  const gold = { id: 1, name: 'Gold' };

  const created = await request.post(`${baseURL}/markets`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      name: marketName,
      creationDate: new Date().toISOString(),
      organizationId: orgId,
      intakeMode: 'form',
      setupObject: {
        priority: [],
        marketDates: [{ date: today }, { date: tomorrow }],
        tiers: [gold],
        locations: [NORTH_WING, SOUTH_WING],
        sections: [
          { ...AISLE_A, location: NORTH_WING, tier: gold, count: 4 },
          { ...AISLE_B, location: SOUTH_WING, tier: gold, count: 3 },
        ],
        assignmentOptions: {
          maxAssignmentsPerVendor: null,
          maxHalfTableProportionPerSection: null,
        },
      },
    },
  });
  await ok(created, 'Market creation');
  const { market_id: marketId } = (await created.json()) as { market_id: string };

  await saveApplicationForm(request, baseURL, marketId, {
    fields: Object.values(DAY_MAP_QUESTIONS).map((question, order) => ({
      ...question,
      type: 'text',
      required: false,
      options: [],
      order,
    })),
  });
  await decideReviewSetup(request, baseURL, marketId);

  // Laid out in Draft, so each section counts its tables (T257): a hall 30 m across each.
  const row = (section: string, count: number, y: number) =>
    Array.from({ length: count }, (_, i) => ({
      section,
      at: [4000 + i * 2400, y] as [number, number],
    }));
  if (!options.inAssignment) {
    await startLayout(request, baseURL, marketId, {
      locationId: NORTH_WING.id,
      metresAcross: 30,
      tables: row(AISLE_A.id, 4, 6000),
      tablePrefix: 'north-table',
      zones: [{ label: 'Stage', box: [17_000, 11_000, 6000, 3000], rotation: 30 }],
    });
    await startLayout(request, baseURL, marketId, {
      locationId: SOUTH_WING.id,
      metresAcross: 30,
      tables: row(AISLE_B.id, 3, 9000),
      tablePrefix: 'south-table',
      // Another image than North Wing's, so a map's two floorplans are told apart (T501).
      image: SECOND_FLOORPLAN_PATH,
    });
  }

  insertApplications(
    DAY_MAP_VENDORS.map((vendor) =>
      approvedVendorApplication(marketId, vendor.email, {
        dates: [today, tomorrow],
        tiers: ['Gold'],
        // A vendor with no section ranked is refused assignment, by hand as by a run.
        sections: [AISLE_A.name, AISLE_B.name],
        fullName: vendor.fullName,
        extra: {
          essential_preferred_name: vendor.preferredName,
          ...(vendor.answers.businessName
            ? { [DAY_MAP_QUESTIONS.name.key]: vendor.answers.businessName }
            : {}),
          ...(vendor.answers.website
            ? { [DAY_MAP_QUESTIONS.website.key]: vendor.answers.website }
            : {}),
          ...(vendor.answers.instagram
            ? { [DAY_MAP_QUESTIONS.instagram.key]: vendor.answers.instagram }
            : {}),
        },
      }),
    ),
  );

  const move = async (toPhase: string) =>
    ok(
      await request.post(`${baseURL}/markets/${marketId}/transition`, {
        headers: { 'Content-Type': 'application/json' },
        data: { toPhase },
      }),
      `Transition to ${toPhase}`,
    );
  await move('applications');
  await move('assignment');

  // Seated by hand on an allocation, as Publish results asks (T316), each in the seat it names.
  await allocateThenFreeEverySeat(request, baseURL, marketId);
  for (const vendor of DAY_MAP_VENDORS) {
    for (const [date, seat] of [
      [today, vendor.today],
      [tomorrow, vendor.tomorrow],
    ] as const) {
      if (!seat) continue;
      await ok(
        await request.put(`${baseURL}/markets/${marketId}/placements`, {
          data: {
            email: vendor.email,
            date,
            tableCode: seat.tableCode,
            tableChoice: seat.tableChoice,
          },
        }),
        `Seating ${vendor.email} on ${date}`,
      );
    }
  }
  const [checkedIn] = DAY_MAP_VENDORS;
  const seeded: SeededMarketDayMap = {
    marketId,
    marketName,
    slug: marketNameToSlug(marketName),
    orgId,
    today,
    tomorrow,
    seededAt,
    north: NORTH_WING,
    south: SOUTH_WING,
    vendors: DAY_MAP_VENDORS,
    checkedIn,
    personalMarkers: [
      ...DAY_MAP_VENDORS.flatMap((vendor) => [vendor.email, vendor.fullName, vendor.preferredName]),
      'orders@sweet-thread.test',
      NOTE,
    ],
  };
  if (options.inAssignment) return seeded;

  await publishResults(request, baseURL, email, marketId);
  await move('market_days');

  await ok(
    await request.post(`${baseURL}/markets/${marketId}/attendance`, {
      data: { vendorEmail: checkedIn.email, date: today },
    }),
    'Checking in',
  );
  await ok(
    await request.put(
      `${baseURL}/markets/${marketId}/vendor-notes/${encodeURIComponent(DAY_MAP_VENDORS[1].email)}`,
      { data: { note: NOTE } },
    ),
    'Writing a note',
  );

  if (options.publicMap) {
    await ok(
      await request.put(`${baseURL}/markets/${marketId}/public-map`, {
        data: {
          enabled: true,
          nameQuestion: DAY_MAP_QUESTIONS.name.key,
          websiteQuestion: DAY_MAP_QUESTIONS.website.key,
          instagramQuestion: DAY_MAP_QUESTIONS.instagram.key,
        },
      }),
      'Turning the public map on',
    );
  }

  return seeded;
}
