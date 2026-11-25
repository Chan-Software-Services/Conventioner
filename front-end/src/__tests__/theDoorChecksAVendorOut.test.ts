// @vitest-environment happy-dom
/**
 * An organizer checks a vendor out at the door (T496): on Attendance, whoever may check vendors in
 * checks a checked-in vendor out on their row and can undo it, and the row says when they were
 * checked out and by whom.
 *
 * The door recorded that a vendor came and nothing that they left. A check-out is three fields
 * beside the check-in's on the day's one record, so a vendor checked out still came: their status,
 * the count and the printed roster read as before, the filters list them under Checked out, never
 * under Checked in, and the map is given the same rows, which it draws checked out (T501,
 * `theDoorAsAMap.test.ts`).
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
const DEE = 'dee@example.com';
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

/**
 * The server's answer to a check-out: the day's check-out, made now by the organizer looking, or
 * one stored before by another organizer, or by the vendor's own scan when `by` is null.
 */
function checkedOut(by: string | null) {
  return {
    message: 'Checked out',
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

/**
 * What a row offers, by test id: the button that ends it, if any, and each line of its chips, in the
 * markup's order, an "Undo?" before the chip it undoes; the plain "by" line after a chip is not
 * counted here.
 */
const offers = (wrapper: VueWrapper, email: string) => ({
  action: rowOf(wrapper, email)
    .findAll('.door-action button')
    .map((button) => button.attributes('data-testid')),
  lines: rowOf(wrapper, email)
    .findAll('.door-line')
    .map((line) =>
      [...line.element.querySelectorAll('.door-undo, .chip')].map((part) =>
        part.getAttribute('data-testid'),
      ),
    ),
});

/** A row not checked in: Check in, and its status alone. */
const NOT_CHECKED_IN_OFFERS = {
  action: ['attendance-check-in'],
  lines: [['attendance-row-status']],
};
/** A row checked in: Check out, and the check-in's Undo left of its status. */
const HERE_OFFERS = {
  action: ['attendance-check-out'],
  lines: [['attendance-undo', 'attendance-row-status']],
};
/** A row checked out: no button, its status alone, and the check-out's Undo left of its out chip. */
const OUT_OFFERS = {
  action: [],
  lines: [['attendance-row-status'], ['attendance-undo-check-out', 'attendance-row-out']],
};

const status = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email).get('[data-testid="attendance-row-status"]');

const outChip = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email).find('[data-testid="attendance-row-out"]');

/** The plain line after a chip, "by you" or "by <address>", if the chip has one. */
const statusBy = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email).find('[data-testid="attendance-row-status-by"]');

const outBy = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email).find('[data-testid="attendance-row-out-by"]');

/** A chip and its "by" line, as one reads them: "Checked out 3:02 PM by you". */
const said = (chip: { text(): string }, by: { exists(): boolean; text(): string }) =>
  by.exists() ? `${chip.text()} ${by.text()}` : chip.text();

const statusSaid = (wrapper: VueWrapper, email: string) =>
  said(status(wrapper, email), statusBy(wrapper, email));

const outSaid = (wrapper: VueWrapper, email: string) =>
  said(outChip(wrapper, email), outBy(wrapper, email));

/** A row's chips, in the markup's order. */
const chips = (wrapper: VueWrapper, email: string) =>
  rowOf(wrapper, email)
    .findAll('.chip')
    .map((chip) => chip.attributes('data-testid'));

const button = (wrapper: VueWrapper, email: string, testid: string) =>
  rowOf(wrapper, email).get(`[data-testid="${testid}"]`);

/** The bar's count and each filter's. */
function counts(wrapper: VueWrapper) {
  return {
    summary: wrapper.get('[data-testid="attendance-summary"]').text(),
    all: wrapper.get('[data-testid="attendance-show-all"]').text(),
    notCheckedIn: wrapper.get('[data-testid="attendance-show-not-checked-in"]').text(),
    checkedIn: wrapper.get('[data-testid="attendance-show-checked-in"]').text(),
    checkedOut: wrapper.get('[data-testid="attendance-show-checked-out"]').text(),
  };
}

/** The printed roster, teleported to the page's body: each row's text, its Checked in cell among it. */
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
    expect(offers(wrapper, ANA)).toEqual(NOT_CHECKED_IN_OFFERS);
    expect(outChip(wrapper, ANA).exists()).toBe(false);
  });

  it('a checked-in row ends in a primary Check out, its "Undo?" left of its status', async () => {
    serve(here(ANA, 'A1'));
    const wrapper = await open();
    expect(offers(wrapper, ANA)).toEqual(HERE_OFFERS);
    const checkOut = button(wrapper, ANA, 'attendance-check-out');
    expect(checkOut.text()).toBe('Check out');
    expect(checkOut.classes()).toEqual(expect.arrayContaining(['btn', 'btn--primary']));
    expect(checkOut.classes()).toContain('btn--compact');
    expect(checkOut.attributes('aria-label')).toBe(`Check out ${ANA}`);
    const undo = button(wrapper, ANA, 'attendance-undo');
    expect(undo.element.tagName).toBe('BUTTON');
    expect(undo.attributes('type')).toBe('button');
    expect(undo.text()).toBe('Undo?');
    expect(undo.classes()).toEqual(['door-undo']);
    expect(undo.attributes('aria-label')).toBe(`Undo ${ANA}'s check-in`);
    expect(outChip(wrapper, ANA).exists()).toBe(false);
  });

  it('a checked-out row has no button, and one "Undo?", of the check-out, left of its out chip', async () => {
    serve(out(ANA, 'A1', ORGANIZER));
    const wrapper = await open();
    expect(offers(wrapper, ANA)).toEqual(OUT_OFFERS);
    expect(rowOf(wrapper, ANA).find('[data-testid="attendance-undo"]').exists()).toBe(false);
    const undo = button(wrapper, ANA, 'attendance-undo-check-out');
    expect(undo.element.tagName).toBe('BUTTON');
    expect(undo.attributes('type')).toBe('button');
    expect(undo.text()).toBe('Undo?');
    expect(undo.classes()).toEqual(['door-undo']);
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
    expect(offers(wrapper, CY)).toEqual(HERE_OFFERS);

    holdTheRereads();
    api.post.mockResolvedValue({ data: checkedOut(ORGANIZER) });
    await button(wrapper, CY, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith(CHECK_OUT_URL, { vendorEmail: CY, date: TODAY });
    expect(outSaid(wrapper, CY)).toMatch(/^Checked out .+ by you$/);
    expect(offers(wrapper, CY)).toEqual(OUT_OFFERS);
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
    expect(offers(wrapper, ANA)).toEqual(HERE_OFFERS);
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
    ['the organizer looking', ORGANIZER, /^Checked out \d{1,2}:\d{2}\s[AP]M by you$/],
    ['the organizer looking, in another case', 'Org@Example.com', /^Checked out .+ by you$/],
    [
      'another organizer',
      OTHER_ORGANIZER,
      new RegExp(`^Checked out \\d{1,2}:\\d{2}\\s[AP]M by ${OTHER_ORGANIZER}$`),
    ],
    ["the vendor's own scan", null, /^Scanned out at \d{1,2}:\d{2}\s[AP]M$/],
  ])('says a check-out by %s', async (_name, by, words) => {
    serve(out(ANA, 'A1', by));
    const wrapper = await open();
    expect(outSaid(wrapper, ANA)).toMatch(words);
  });

  it('holds the state and time in the chip, and "by" whom on a plain line after it, the address drawn to break only before its "@" or a dot', async () => {
    serve({ ...out(ANA, 'A1', OTHER_ORGANIZER), checkedInBy: OTHER_ORGANIZER });
    const wrapper = await open();
    expect(outChip(wrapper, ANA).text()).toMatch(/^Checked out \d{1,2}:\d{2}\s[AP]M$/);
    expect(status(wrapper, ANA).text()).toMatch(/^Checked in \d{1,2}:\d{2}\s[AP]M$/);
    for (const [chip, by] of [
      [outChip(wrapper, ANA), outBy(wrapper, ANA)],
      [status(wrapper, ANA), statusBy(wrapper, ANA)],
    ] as const) {
      // A pill of one line: nothing but its words in it.
      expect(chip.element.children).toHaveLength(0);
      // The line follows its chip, in the chip's own line of the row.
      expect(by.element.previousElementSibling?.lastElementChild).toBe(chip.element);
      expect(by.classes()).toEqual(['door-chip-by']);
      expect(by.text()).toBe(`by ${OTHER_ORGANIZER}`);
      expect(by.findAll('.email-address').map((half) => half.text())).toEqual([
        'sam',
        '@example.com',
      ]);
    }
  });

  it('the check-in chip says "Checked in <time>" as the check-out says "Checked out <time>", and "Scanned in at <time>" for the vendor\'s own', async () => {
    serve(
      here(ANA, 'A1'),
      { ...here(BEN, 'A2'), checkedInBy: OTHER_ORGANIZER },
      { ...here(DEE, 'A3'), checkedInBy: null, checkedInVia: 'door_code' },
    );
    const wrapper = await open();
    expect(status(wrapper, ANA).text()).toMatch(/^Checked in \d{1,2}:\d{2}\s[AP]M$/);
    expect(statusBy(wrapper, ANA).text()).toBe('by you');
    expect(status(wrapper, BEN).text()).toMatch(/^Checked in \d{1,2}:\d{2}\s[AP]M$/);
    expect(statusBy(wrapper, BEN).text()).toBe(`by ${OTHER_ORGANIZER}`);
    expect(status(wrapper, DEE).text()).toMatch(/^Scanned in at \d{1,2}:\d{2}\s[AP]M$/);
    expect(statusBy(wrapper, DEE).exists()).toBe(false);
  });

  it('keeps the attention of a vendor here at another table', async () => {
    serve({
      ...out(ANA, 'A1', ORGANIZER),
      state: 'here_elsewhere',
      checkedInTableCode: 'A7',
    });
    const wrapper = await open();
    // The chip in the attention tone says the state and the time; where they went follows who made
    // it on the plain line, so the chip fits a narrow phone's row at any time of day (T501).
    expect(status(wrapper, ANA).text()).toMatch(/^Checked in \d{1,2}:\d{2}\s[AP]M$/);
    expect(statusBy(wrapper, ANA).text()).toBe('by you, at\u00a0table\u00a0A7');
    expect(status(wrapper, ANA).classes()).toContain('chip--attention');
    expect(outSaid(wrapper, ANA)).toMatch(/^Checked out .+ by you$/);
  });

  it('a record from before the check-out, with none of its fields, reads as not checked out', async () => {
    const old = Object.fromEntries(
      Object.entries(here(ANA, 'A1')).filter(([field]) => !field.startsWith('checkedOut')),
    );
    serve(old as unknown as Row);
    const wrapper = await open();
    expect(outChip(wrapper, ANA).exists()).toBe(false);
    expect(offers(wrapper, ANA)).toEqual(HERE_OFFERS);
  });
});

describe('a check-out and its undo', () => {
  it("show on the row from the server's answer at once, and a re-read follows", async () => {
    serve(here(ANA, 'A1'), expected(BEN, 'A2'));
    const wrapper = await open();
    expect(rosterReads()).toBe(1);
    holdTheRereads();

    api.post.mockResolvedValue({ data: checkedOut(ORGANIZER) });
    await button(wrapper, ANA, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(CHECK_OUT_URL, { vendorEmail: ANA, date: TODAY });
    expect(outSaid(wrapper, ANA)).toMatch(/^Checked out \d{1,2}:\d{2}\s[AP]M by you$/);
    expect(statusSaid(wrapper, ANA)).toMatch(/^Checked in .+ by you$/);
    expect(offers(wrapper, ANA)).toEqual(OUT_OFFERS);
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
    expect(statusSaid(wrapper, ANA)).toMatch(/^Checked in .+ by you$/);
    expect(offers(wrapper, ANA)).toEqual(HERE_OFFERS);
    expect(rosterReads()).toBe(3);
  });

  it.each([
    [
      'another organizer',
      'door@example.com',
      /^Checked out \d{1,2}:\d{2}\s[AP]M by door@example\.com$/,
    ],
    ["the vendor's own scan", null, /^Scanned out at \d{1,2}:\d{2}\s[AP]M$/],
  ])('a check-out made after %s shows theirs at once, never "by you"', async (_who, by, said) => {
    serve(here(ANA, 'A1'));
    const wrapper = await open();
    holdTheRereads();

    api.post.mockResolvedValue({ data: checkedOut(by) });
    await button(wrapper, ANA, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(outSaid(wrapper, ANA)).toMatch(said);
    expect(offers(wrapper, ANA)).toEqual(OUT_OFFERS);
  });

  it("the undo of a vendor's own check-out clears how it was made", async () => {
    serve(out(ANA, 'A1', null));
    const wrapper = await open();
    holdTheRereads();
    api.delete.mockResolvedValue({ data: { message: 'Check-out undone' } });
    api.post.mockResolvedValue({ data: checkedOut(ORGANIZER) });

    await button(wrapper, ANA, 'attendance-undo-check-out').trigger('click');
    await flushPromises();
    await button(wrapper, ANA, 'attendance-check-out').trigger('click');
    await flushPromises();

    expect(outSaid(wrapper, ANA)).toMatch(/^Checked out .+ by you$/);
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

    settle({ data: checkedOut(ORGANIZER) });
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
    expect(status(wrapper, ANA).text()).toBe('Not checked in');
    expect(offers(wrapper, ANA)).toEqual(NOT_CHECKED_IN_OFFERS);
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

    expect(outSaid(wrapper, BEN)).toMatch(new RegExp(`^Checked out .+ by ${OTHER_ORGANIZER}$`));
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

describe('the filters read a check-out, and every count still counts the vendor as come', () => {
  /** The day with nobody checked out, and the same day with Ana and the seatless Cy checked out. */
  const day = (checkedOut: boolean) => [
    checkedOut ? out(ANA, 'A1', ORGANIZER) : here(ANA, 'A1'),
    expected(BEN, 'A2'),
    here(DEE, 'A3'),
    checkedOut ? { ...seatless(CY), checkedOutAt: LEFT, checkedOutBy: ORGANIZER } : seatless(CY),
  ];

  /** What the page says, and which rows each filter and search shows. */
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
      statuses: [ANA, BEN, CY, DEE].map((email) => status(wrapper, email).text()),
      tones: [ANA, BEN, CY, DEE].map((email) =>
        status(wrapper, email)
          .classes()
          .filter((name) => name.startsWith('chip--')),
      ),
      printed: printed(),
      all: await shownUnder('all'),
      notCheckedIn: await shownUnder('not-checked-in'),
      checkedIn: await shownUnder('checked-in'),
      checkedOut: await shownUnder('checked-out'),
      found: [await shownUnder('all'), await search('ana'), await search('A2')],
    };
    // The map is given the roster's rows as the list reads them, `state` unchanged by a check-out;
    // it draws a checked-out vendor in the out shade (T501), which `theDoorAsAMap.test.ts` holds.
    route.query = { view: 'map' };
    await flushPromises();
    const map = wrapper.getComponent({ name: 'AttendanceMap' });
    const mapProps = map.props() as { rows: Row[]; hereWithoutSeat: number };
    const drawn = {
      rows: mapProps.rows.map(({ vendorEmail, state, tableCode, checkedInAt }) => ({
        vendorEmail,
        state,
        tableCode,
        checkedInAt,
      })),
      hereWithoutSeat: mapProps.hereWithoutSeat,
      summary: wrapper.get('[data-testid="attendance-summary"]').text(),
    };
    wrapper.unmount();
    route.query = {};
    return { ...said, map: drawn };
  }

  it('the filters are All, Not checked in, Checked in and Checked out, each vendor under one of the last three', async () => {
    const before = await read(false);
    const after = await read(true);

    expect(before.counts).toEqual({
      summary: '2 of 3 checked in',
      all: 'All 3',
      notCheckedIn: 'Not checked in 1',
      checkedIn: 'Checked in 2',
      checkedOut: 'Checked out 0',
    });
    expect(after.counts).toEqual({
      summary: '2 of 3 checked in',
      all: 'All 3',
      notCheckedIn: 'Not checked in 1',
      checkedIn: 'Checked in 1',
      checkedOut: 'Checked out 1',
    });
    // The seatless Cy is listed under All, and under Checked in or Checked out by their own
    // check-out, never counted.
    expect(before.all).toEqual([ANA, BEN, DEE, CY]);
    expect(before.notCheckedIn).toEqual([BEN]);
    expect(before.checkedIn).toEqual([ANA, DEE, CY]);
    expect(before.checkedOut).toEqual([]);
    expect(after.all).toEqual([ANA, BEN, DEE, CY]);
    expect(after.notCheckedIn).toEqual([BEN]);
    expect(after.checkedIn).toEqual([DEE]);
    expect(after.checkedOut).toEqual([ANA, CY]);
    // The last three are exclusive, and together every row.
    const underOne = [...after.notCheckedIn, ...after.checkedIn, ...after.checkedOut];
    expect([...underOne].sort()).toEqual([...after.all].sort());
    expect(new Set(underOne).size).toBe(underOne.length);
  });

  it("the summary, the statuses, the search, the map's rows and the printed roster read the same", async () => {
    const before = await read(false);
    const after = await read(true);

    const same = (said: Awaited<ReturnType<typeof read>>) => ({
      summary: said.counts.summary,
      all: said.counts.all,
      notCheckedIn: said.counts.notCheckedIn,
      statuses: said.statuses,
      tones: said.tones,
      printed: said.printed,
      shownUnderAll: said.all,
      shownUnderNotCheckedIn: said.notCheckedIn,
      found: said.found,
      map: said.map,
    });
    expect(same(after)).toEqual(same(before));
    expect(after.printed).toHaveLength(4);
    expect(after.printed.join(' ')).not.toMatch(/\bOut\b|Checked out|Scanned out/);
  });

  it('the bar counts every check-in of the day, checked out or not', async () => {
    serve(out(ANA, 'A1', ORGANIZER), out(BEN, 'A2', null), expected(DEE, 'A3'));
    const wrapper = await open();
    expect(counts(wrapper)).toEqual({
      summary: '2 of 3 checked in',
      all: 'All 3',
      notCheckedIn: 'Not checked in 1',
      checkedIn: 'Checked in 0',
      checkedOut: 'Checked out 2',
    });
  });

  it('a filter that leaves no row says "Nobody matches."', async () => {
    serve(here(ANA, 'A1'));
    const wrapper = await open();
    await wrapper.get('[data-testid="attendance-show-checked-out"]').trigger('click');
    expect(wrapper.findAll('[data-testid="attendance-row"]')).toHaveLength(0);
    expect(wrapper.get('.door-note').text()).toBe('Nobody matches.');
  });
});

describe('a vendor who never checked in reads "Not checked in" at every time of day', () => {
  const [year, month, date] = TODAY.split('-').map(Number) as [number, number, number];
  const yesterday = calendarToday(new Date(year, month - 1, date - 1));
  const tomorrow = calendarToday(new Date(year, month - 1, date + 1));

  it.each([
    ['a day to come', tomorrow, MarketPhase.MarketDays],
    ['the day itself', TODAY, MarketPhase.MarketDays],
    ['a day over', yesterday, MarketPhase.MarketDays],
    ['an archived market', yesterday, MarketPhase.Archived],
  ])('on %s', async (_name, shown, phase) => {
    marketRef.value = { ...marketOf('market-a'), phase } as Market;
    route.query = { date: shown };
    api.get.mockResolvedValue({
      data: {
        dates: [yesterday, TODAY, tomorrow],
        roster: [
          { ...out(ANA, 'A1', ORGANIZER), date: shown },
          { ...expected(BEN, 'A2'), date: shown },
        ],
      },
    });
    const wrapper = await open();
    expect(statusSaid(wrapper, ANA)).toMatch(/^Checked in .+ by you$/);
    expect(status(wrapper, BEN).text()).toBe('Not checked in');
    expect(wrapper.get('[data-testid="attendance-show-not-checked-in"]').text()).toBe(
      'Not checked in 1',
    );
    for (const old of ['Here', 'Expected', 'Not yet', 'Did not come']) {
      expect(wrapper.text()).not.toContain(old);
    }
  });
});
