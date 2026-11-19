// @vitest-environment happy-dom
/**
 * An organizer checks a vendor out at the door (T496): on Attendance, whoever may check vendors in
 * checks a checked-in vendor out on their row and can undo it, and the row says when they were
 * checked out and by whom.
 *
 * The door recorded that a vendor came and nothing that they left. A check-out is three fields
 * beside the check-in's on the day's one record, so a vendor checked out still came: their status,
 * the count, the Show buttons, the map and the printed roster read as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AxiosError, type AxiosResponse } from 'axios';
import { reactive, ref } from 'vue';

import AttendanceStatusView from '@/views/AttendanceStatusView.vue';
import { MarketPhase, type Market } from '@/assets/types/datatypes';
import { calendarToday } from '@/utils/marketGuide';
import { answersRefusing, VIEWER_ANSWERS } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({ market: marketRef, status: ref('loaded'), refresh: vi.fn() }),
}));
vi.mock('@/utils/vendorDetails', () => ({
  useVendorDetails: () => ({ loaded: { value: false }, load: vi.fn() }),
}));

const route = reactive({ params: { marketId: 'market-a' }, query: {} as Record<string, string> });
const TODAY = calendarToday();
const ORGANIZER = 'org@example.com';
const OTHER_ORGANIZER = 'sam@example.com';
const ANA = 'ana@example.com';
const BEN = 'ben@example.com';
const CY = 'cy@example.com';
const ARRIVED = '2099-08-01T09:41:00Z';
const LEFT = '2099-08-01T16:05:00Z';
const ROSTER_URL = '/markets/market-a/attendance';
const CHECK_OUT_URL = '/markets/market-a/attendance/check-out';

function marketOf(id: string, answers = answersRefusing()): Market {
  return {
    id,
    name: id,
    phase: MarketPhase.MarketDays,
    actionRefusals: answers,
  } as unknown as Market;
}
const marketRef = ref<Market | null>(marketOf('market-a'));

interface Row {
  date: string;
  vendorEmail: string;
  vendorName: string;
  tableCode: string | null;
  tableChoice: string | null;
  section: string | null;
  location: string | null;
  state: 'expected' | 'here' | 'here_elsewhere' | 'here_without_seat';
  checkedInTableCode: string | null;
  checkedInAt: string | null;
  checkedInBy: string | null;
  checkedInVia: string | null;
  checkedOutAt: string | null;
  checkedOutBy: string | null;
  checkedOutVia: string | null;
}

/** A vendor's seat today, nobody in, as the server serves it. */
function expected(email: string, tableCode: string): Row {
  return {
    date: TODAY,
    vendorEmail: email,
    vendorName: '',
    tableCode,
    tableChoice: 'Full Table',
    section: 'Main Hall',
    location: 'Main Hall',
    state: 'expected',
    checkedInTableCode: null,
    checkedInAt: null,
    checkedInBy: null,
    checkedInVia: null,
    checkedOutAt: null,
    checkedOutBy: null,
    checkedOutVia: null,
  };
}

/** Checked in by the organizer looking, and not out. */
function here(email: string, tableCode: string): Row {
  return {
    ...expected(email, tableCode),
    state: 'here',
    checkedInTableCode: tableCode,
    checkedInAt: ARRIVED,
    checkedInBy: ORGANIZER,
  };
}

/** Checked in, then out: by an organizer, or by the vendor's own scan when `by` is null. */
function out(email: string, tableCode: string, by: string | null): Row {
  return {
    ...here(email, tableCode),
    checkedOutAt: LEFT,
    checkedOutBy: by,
    checkedOutVia: by ? null : 'door_code',
  };
}

/** Checked in with no table today, after a free. */
function seatless(email: string): Row {
  return {
    ...here(email, 'A9'),
    tableCode: null,
    tableChoice: null,
    section: null,
    location: null,
    state: 'here_without_seat',
  };
}

/** Every roster read from here on answers `rows`. */
function serve(...rows: Row[]) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === ROSTER_URL ? { dates: [TODAY], roster: rows } : {} }),
  );
}

/** The roster's next reads never answer, so what the row shows is the write's own answer. */
function holdTheRereads() {
  api.get.mockImplementation((url: string) =>
    url === ROSTER_URL ? new Promise(() => {}) : Promise.resolve({ data: {} }),
  );
}

function rosterReads(): number {
  return api.get.mock.calls.filter(([url]) => url === ROSTER_URL).length;
}

function refusedWith(status: number, message?: string): AxiosError {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  error.response = { status, data: message ? { message } : {} } as AxiosResponse;
  return error;
}

async function open(): Promise<VueWrapper> {
  const wrapper = mount(AttendanceStatusView, {
    attachTo: document.body,
    global: {
      stubs: {
        MarketFrame: { template: '<div><slot /></div>' },
        VendorDrawer: true,
        DoorCodeScreen: true,
        VendorNotes: true,
        AttendanceMap: true,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

const rowOf = (wrapper: VueWrapper, email: string) =>
  wrapper.get(`[data-testid="attendance-row"][data-vendor="${email}"]`);

/** The test ids of a row's buttons in its action, in the markup's order. */
const actions = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email)
    .findAll('.door-action button')
    .map((button) => button.attributes('data-testid'));

const status = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email).get('[data-testid="attendance-row-status"]');

const outChip = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email).find('[data-testid="attendance-row-out"]');

/** A row's chips, in the markup's order. */
const chips = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email)
    .findAll('.chip')
    .map((chip) => chip.attributes('data-testid'));

const button = (wrapper: VueWrapper, email: string, testid: string) =>
  rowOf(wrapper, email).get(`[data-testid="${testid}"]`);

/** What the page reads the same whatever a check-out says: the count and the Show buttons. */
function counts(wrapper: VueWrapper) {
  return {
    summary: wrapper.get('[data-testid="attendance-summary"]').text(),
    all: wrapper.get('[data-testid="attendance-show-all"]').text(),
    notYet: wrapper.get('[data-testid="attendance-show-not-yet"]').text(),
    here: wrapper.get('[data-testid="attendance-show-here"]').text(),
  };
}

/** The printed roster, teleported to the page's body: each row's Here cell. */
function printed(): string[] {
  return [...document.querySelectorAll('[data-testid="attendance-print-row"]')].map(
    (row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.resetAllMocks();
  route.params.marketId = 'market-a';
  route.query = {};
  marketRef.value = marketOf('market-a');
  localStorage.setItem('user', JSON.stringify({ email: ORGANIZER }));
});
afterEach(() => localStorage.clear());

describe("each row's buttons", () => {
  it('an expected row offers Check in, as before', async () => {
    serve(expected(ANA, 'A1'));
    const wrapper = await open();
    expect(actions(wrapper, ANA)).toEqual(['attendance-check-in']);
    expect(outChip(wrapper, ANA).exists()).toBe(false);
  });

  it('a checked-in row offers a primary Check out, then Undo', async () => {
    serve(here(ANA, 'A1'));
    const wrapper = await open();
    expect(actions(wrapper, ANA)).toEqual(['attendance-check-out', 'attendance-undo']);
    const checkOut = button(wrapper, ANA, 'attendance-check-out');
    expect(checkOut.text()).toBe('Check out');
    expect(checkOut.classes()).toEqual(expect.arrayContaining(['btn', 'btn--primary']));
    expect(checkOut.classes()).toContain('btn--compact');
    expect(checkOut.attributes('aria-label')).toBe(`Check out ${ANA}`);
    const undo = button(wrapper, ANA, 'attendance-undo');
    expect(undo.text()).toBe('Undo');
    expect(undo.classes()).toContain('btn--secondary');
    expect(undo.attributes('aria-label')).toBe(`Undo ${ANA}'s check-in`);
    expect(outChip(wrapper, ANA).exists()).toBe(false);
  });

  it('a checked-out row offers one Undo, of the check-out', async () => {
    serve(out(ANA, 'A1', ORGANIZER));
    const wrapper = await open();
    expect(actions(wrapper, ANA)).toEqual(['attendance-undo-check-out']);
    const undo = button(wrapper, ANA, 'attendance-undo-check-out');
    expect(undo.text()).toBe('Undo');
    expect(undo.classes()).toEqual(expect.arrayContaining(['btn--secondary', 'btn--compact']));
    expect(undo.attributes('aria-label')).toBe(`Undo ${ANA}'s check-out`);
  });

  it('names each button by the name the vendor goes by', async () => {
    serve(
      { ...here(ANA, 'A1'), vendorName: 'Ana Loom' },
      { ...out(BEN, 'A2', ORGANIZER), vendorName: 'Ben Kiln' },
    );
    const wrapper = await open();
    expect(button(wrapper, ANA, 'attendance-check-out').attributes('aria-label')).toBe(
      'Check out Ana Loom',
    );
    expect(button(wrapper, BEN, 'attendance-undo-check-out').attributes('aria-label')).toBe(
      "Undo Ben Kiln's check-out",
    );
  });

  it('a vendor here with no table can be checked out', async () => {
    serve(expected(ANA, 'A1'), seatless(CY));
    const wrapper = await open();
    expect(actions(wrapper, CY)).toEqual(['attendance-check-out', 'attendance-undo']);

    holdTheRereads();
    api.post.mockResolvedValue({ data: { message: 'Checked out', checkedOutAt: LEFT } });
    await button(wrapper, CY, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith(CHECK_OUT_URL, { vendorEmail: CY, date: TODAY });
    expect(outChip(wrapper, CY).text()).toMatch(/^Out .+ by you$/);
    expect(actions(wrapper, CY)).toEqual(['attendance-undo-check-out']);
    // Still listed under the day's seats, counted apart.
    expect(wrapper.get('[data-testid="attendance-unseated-heading"]').text()).toBe(
      'Checked in, with no table on this date (1)',
    );
  });

  it('a check-out is offered on a past day, wherever there is a check-in', async () => {
    const [year, month, day] = TODAY.split('-').map(Number) as [number, number, number];
    const yesterday = calendarToday(new Date(year, month - 1, day - 1));
    route.query = { date: yesterday };
    api.get.mockResolvedValue({
      data: { dates: [yesterday, TODAY], roster: [{ ...here(ANA, 'A1'), date: yesterday }] },
    });
    const wrapper = await open();
    expect(actions(wrapper, ANA)).toEqual(['attendance-check-out', 'attendance-undo']);
  });
});

describe("a checked-out row's chips", () => {
  it('keeps its status chip as it is and gains the out chip after it', async () => {
    serve(here(ANA, 'A1'), out(BEN, 'A2', ORGANIZER));
    const wrapper = await open();
    expect(chips(wrapper, ANA)).toEqual(['attendance-row-status']);
    expect(chips(wrapper, BEN)).toEqual(['attendance-row-status', 'attendance-row-out']);
    // The status says the arrival, as on a row not checked out.
    expect(status(wrapper, BEN).text()).toBe(status(wrapper, ANA).text());
    expect(status(wrapper, BEN).classes()).toContain('chip--positive');
    expect(outChip(wrapper, BEN).classes()).toEqual(
      expect.arrayContaining(['chip', 'chip--neutral']),
    );
  });

  it.each([
    ['the organizer looking', ORGANIZER, /^Out \d{1,2}:\d{2}\s[AP]M by you$/],
    ['the organizer looking, in another case', 'Org@Example.com', /^Out .+ by you$/],
    [
      'another organizer',
      OTHER_ORGANIZER,
      new RegExp(`^Out \\d{1,2}:\\d{2}\\s[AP]M by ${OTHER_ORGANIZER}$`),
    ],
    ["the vendor's own scan", null, /^Scanned out at \d{1,2}:\d{2}\s[AP]M$/],
  ])('says a check-out by %s', async (_name, by, words) => {
    serve(out(ANA, 'A1', by));
    const wrapper = await open();
    expect(outChip(wrapper, ANA).text()).toMatch(words);
  });

  it('keeps the attention of a vendor here at another table', async () => {
    serve({
      ...out(ANA, 'A1', ORGANIZER),
      state: 'here_elsewhere',
      checkedInTableCode: 'A7',
    });
    const wrapper = await open();
    expect(status(wrapper, ANA).text()).toMatch(/, at table A7$/);
    expect(status(wrapper, ANA).classes()).toContain('chip--attention');
    expect(outChip(wrapper, ANA).text()).toMatch(/^Out .+ by you$/);
  });

  it('a record from before the check-out, with none of its fields, reads as not checked out', async () => {
    const old = Object.fromEntries(
      Object.entries(here(ANA, 'A1')).filter(([field]) => !field.startsWith('checkedOut')),
    );
    serve(old as unknown as Row);
    const wrapper = await open();
    expect(outChip(wrapper, ANA).exists()).toBe(false);
    expect(actions(wrapper, ANA)).toEqual(['attendance-check-out', 'attendance-undo']);
  });
});

describe('a check-out and its undo', () => {
  it("show on the row from the server's answer at once, and a re-read follows", async () => {
    serve(here(ANA, 'A1'), expected(BEN, 'A2'));
    const wrapper = await open();
    expect(rosterReads()).toBe(1);
    holdTheRereads();

    api.post.mockResolvedValue({ data: { message: 'Checked out', checkedOutAt: LEFT } });
    await button(wrapper, ANA, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(CHECK_OUT_URL, { vendorEmail: ANA, date: TODAY });
    expect(outChip(wrapper, ANA).text()).toMatch(/^Out \d{1,2}:\d{2}\s[AP]M by you$/);
    expect(status(wrapper, ANA).text()).toMatch(/ by you$/);
    expect(actions(wrapper, ANA)).toEqual(['attendance-undo-check-out']);
    expect(rosterReads()).toBe(2);

    api.delete.mockResolvedValue({ data: { message: 'Check-out undone' } });
    await button(wrapper, ANA, 'attendance-undo-check-out').trigger('click');
    await flushPromises();

    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(api.delete).toHaveBeenCalledWith(CHECK_OUT_URL, {
      data: { vendorEmail: ANA, date: TODAY },
    });
    expect(outChip(wrapper, ANA).exists()).toBe(false);
    // Still checked in: the undo of a check-out is not the undo of the check-in.
    expect(status(wrapper, ANA).text()).toMatch(/ by you$/);
    expect(actions(wrapper, ANA)).toEqual(['attendance-check-out', 'attendance-undo']);
    expect(rosterReads()).toBe(3);
  });

  it("the undo of a vendor's own check-out clears how it was made", async () => {
    serve(out(ANA, 'A1', null));
    const wrapper = await open();
    holdTheRereads();
    api.delete.mockResolvedValue({ data: { message: 'Check-out undone' } });
    api.post.mockResolvedValue({ data: { message: 'Checked out', checkedOutAt: LEFT } });

    await button(wrapper, ANA, 'attendance-undo-check-out').trigger('click');
    await flushPromises();
    await button(wrapper, ANA, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(outChip(wrapper, ANA).text()).toMatch(/^Out .+ by you$/);
  });

  it('hold both of the row’s buttons busy while the write is out, and no other row’s', async () => {
    serve(here(ANA, 'A1'), here(BEN, 'A2'));
    const wrapper = await open();
    holdTheRereads();
    let settle!: (value: unknown) => void;
    api.post.mockReturnValue(new Promise((resolve) => (settle = resolve)));

    await button(wrapper, ANA, 'attendance-check-out').trigger('click');
    expect(button(wrapper, ANA, 'attendance-check-out').attributes('disabled')).toBeDefined();
    expect(button(wrapper, ANA, 'attendance-undo').attributes('disabled')).toBeDefined();
    expect(button(wrapper, BEN, 'attendance-check-out').attributes('disabled')).toBeUndefined();

    settle({ data: { message: 'Checked out', checkedOutAt: LEFT } });
    await flushPromises();
    expect(
      button(wrapper, ANA, 'attendance-undo-check-out').attributes('disabled'),
    ).toBeUndefined();
  });

  it('the Undo of a check-in still undoes the check-in', async () => {
    serve(here(ANA, 'A1'));
    const wrapper = await open();
    holdTheRereads();
    api.delete.mockResolvedValue({ data: { message: 'Check-in undone' } });

    await button(wrapper, ANA, 'attendance-undo').trigger('click');
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith(ROSTER_URL, {
      data: { vendorEmail: ANA, date: TODAY },
    });
    expect(status(wrapper, ANA).text()).toBe('Not yet');
    expect(actions(wrapper, ANA)).toEqual(['attendance-check-in']);
  });
});

describe('a refused check-out', () => {
  it.each([
    ['a check-out', 'attendance-check-out', here(ANA, 'A1'), 'That check-out was not recorded.'],
    [
      'its undo',
      'attendance-undo-check-out',
      out(ANA, 'A1', ORGANIZER),
      'That check-out was not undone.',
    ],
  ])("%s says the server's sentence, else the page's own", async (_name, testid, row, fallback) => {
    serve(row);
    const wrapper = await open();
    const before = rowOf(wrapper, ANA).text();
    const write = testid === 'attendance-check-out' ? api.post : api.delete;

    write.mockRejectedValue(refusedWith(409, 'This market has ended, so check-in is closed.'));
    await button(wrapper, ANA, testid).trigger('click');
    await flushPromises();
    expect(wrapper.get('.door-error').text()).toBe('This market has ended, so check-in is closed.');
    expect(wrapper.get('.door-error').attributes('role')).toBe('alert');
    // Nothing the server did not record shows on the row, and its button can be pressed again.
    expect(rowOf(wrapper, ANA).text()).toBe(before);
    expect(button(wrapper, ANA, testid).attributes('disabled')).toBeUndefined();

    // A refusal that says nothing, a body the server's own handler did not write.
    write.mockRejectedValue(refusedWith(409));
    await button(wrapper, ANA, testid).trigger('click');
    await flushPromises();
    expect(wrapper.get('.door-error').text()).toBe(fallback);
  });

  it('is said only on the market it was made on', async () => {
    api.get.mockImplementation((url: string) => {
      if (url === ROSTER_URL)
        return Promise.resolve({ data: { dates: [TODAY], roster: [here(ANA, 'A1')] } });
      if (url === '/markets/market-b/attendance')
        return Promise.resolve({ data: { dates: [TODAY], roster: [here(BEN, 'B1')] } });
      return Promise.resolve({ data: {} });
    });
    const wrapper = await open();
    let fail!: (error: unknown) => void;
    api.post.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    await button(wrapper, ANA, 'attendance-check-out').trigger('click');

    // The organizer moves to another market before the refusal lands.
    route.params.marketId = 'market-b';
    marketRef.value = marketOf('market-b');
    await flushPromises();
    fail(refusedWith(409, 'This market has ended, so check-in is closed.'));
    await flushPromises();

    expect(wrapper.find(`[data-testid="attendance-row"][data-vendor="${BEN}"]`).exists()).toBe(
      true,
    );
    expect(wrapper.find('.door-error').exists()).toBe(false);
    // The write still out on the last market holds no row of this one.
    expect(button(wrapper, BEN, 'attendance-check-out').attributes('disabled')).toBeUndefined();
  });
});

describe('someone who may not check vendors in', () => {
  it.each([
    ['a Viewer', () => marketOf('market-a', VIEWER_ANSWERS)],
    [
      'anyone once the market is archived',
      () => ({ ...marketOf('market-a'), phase: MarketPhase.Archived }) as Market,
    ],
  ])('%s sees the out chip and no button, and the row ends at its chips', async (_name, market) => {
    marketRef.value = market();
    serve(here(ANA, 'A1'), out(BEN, 'A2', OTHER_ORGANIZER));
    const wrapper = await open();

    expect(outChip(wrapper, BEN).text()).toMatch(new RegExp(`^Out .+ by ${OTHER_ORGANIZER}$`));
    for (const email of [ANA, BEN]) {
      expect(rowOf(wrapper, email).find('.door-action').exists()).toBe(false);
      expect(
        rowOf(wrapper, email).findAll(
          '[data-testid="attendance-check-in"], [data-testid="attendance-check-out"], ' +
            '[data-testid="attendance-undo"], [data-testid="attendance-undo-check-out"]',
        ),
      ).toEqual([]);
      expect(rowOf(wrapper, email).classes()).toContain('door-row--read');
    }
  });
});

describe('nothing else on the page reads a check-out', () => {
  /** The day with nobody checked out, and the same day with Ana and the seatless Cy checked out. */
  const day = (checkedOut: boolean) => [
    checkedOut ? out(ANA, 'A1', ORGANIZER) : here(ANA, 'A1'),
    expected(BEN, 'A2'),
    checkedOut ? { ...seatless(CY), checkedOutAt: LEFT, checkedOutBy: ORGANIZER } : seatless(CY),
  ];

  /** What the page says apart from the row's out chip and its buttons. */
  async function read(checkedOut: boolean) {
    serve(...day(checkedOut));
    const wrapper = await open();
    const shownUnder = async (which: string) => {
      await wrapper.get(`[data-testid="attendance-show-${which}"]`).trigger('click');
      return wrapper
        .findAll('[data-testid="attendance-row"]')
        .map((r) => r.attributes('data-vendor'));
    };
    const search = async (term: string) => {
      await wrapper.get('[data-testid="attendance-search"]').setValue(term);
      const found = wrapper
        .findAll('[data-testid="attendance-row"]')
        .map((r) => r.attributes('data-vendor'));
      await wrapper.get('[data-testid="attendance-search"]').setValue('');
      return found;
    };
    const said = {
      counts: counts(wrapper),
      statuses: [ANA, BEN, CY].map((email) => status(wrapper, email).text()),
      tones: [ANA, BEN, CY].map((email) =>
        status(wrapper, email)
          .classes()
          .filter((name) => name.startsWith('chip--')),
      ),
      printed: printed(),
      all: await shownUnder('all'),
      notYet: await shownUnder('not-yet'),
      here: await shownUnder('here'),
      found: [await shownUnder('all'), await search('ana'), await search('A2')],
    };
    // The map is given the roster's rows as the list reads them: what it draws it reads off
    // `state`, which a check-out never changes.
    route.query = { view: 'map' };
    await flushPromises();
    const map = wrapper.getComponent({ name: 'AttendanceMap' });
    const mapProps = map.props() as { rows: Row[]; notHere: string; hereWithoutSeat: number };
    const drawn = {
      rows: mapProps.rows.map(({ vendorEmail, state, tableCode, checkedInAt }) => ({
        vendorEmail,
        state,
        tableCode,
        checkedInAt,
      })),
      notHere: mapProps.notHere,
      hereWithoutSeat: mapProps.hereWithoutSeat,
      summary: wrapper.get('[data-testid="attendance-summary"]').text(),
    };
    wrapper.unmount();
    route.query = {};
    return { ...said, map: drawn };
  }

  it('the summary, the Show buttons, the search, the map and the printed roster read the same', async () => {
    const before = await read(false);
    const after = await read(true);

    expect(after).toEqual(before);
    // And what they say is a vendor who came: counted, under Checked in, never under Not yet.
    expect(after.counts).toEqual({
      summary: '1 of 2 checked in',
      all: 'All 2',
      notYet: 'Not yet 1',
      here: 'Checked in 1',
    });
    expect(after.here).toEqual([ANA, CY]);
    expect(after.notYet).toEqual([BEN]);
    expect(after.printed).toHaveLength(3);
    expect(after.printed.join(' ')).not.toMatch(/\bOut\b|Scanned out/);
  });

  it('"Did not come" is said of a vendor who never checked in, never of one checked out', async () => {
    const [year, month, date] = TODAY.split('-').map(Number) as [number, number, number];
    const yesterday = calendarToday(new Date(year, month - 1, date - 1));
    route.query = { date: yesterday };
    api.get.mockResolvedValue({
      data: {
        dates: [yesterday, TODAY],
        roster: [
          { ...out(ANA, 'A1', ORGANIZER), date: yesterday },
          { ...expected(BEN, 'A2'), date: yesterday },
        ],
      },
    });
    const wrapper = await open();
    expect(status(wrapper, ANA).text()).toMatch(/ by you$/);
    expect(status(wrapper, BEN).text()).toBe('Did not come');
    expect(wrapper.get('[data-testid="attendance-show-not-yet"]').text()).toBe('Did not come 1');
  });
});
