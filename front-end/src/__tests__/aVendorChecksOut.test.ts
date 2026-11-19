// @vitest-environment happy-dom
/**
 * A vendor checks out on their vendor page, behind the market's self check-in switch (T496).
 *
 * Today's card in each state with the switch on and off, what a scanned door code comes to in
 * each, and a refused check-out; the check-in itself is VendorPage.test.ts's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

import VendorPage from '@/views/VendorPage.vue';
import { IntakeMode, MarketPhase, type Application } from '@/assets/types/datatypes';
import {
  CHECK_IN_ENDED,
  CHECKED_IN_AT_THE_DOOR,
  CHECKED_OUT_AT_THE_DOOR,
  SELF_CHECK_IN_OFF,
  type VendorPageInfo,
  type VendorPageRead,
} from '@/utils/vendorPage';
import { calendarToday } from '@/utils/marketGuide';
import { getTimestampTime } from '@/utils/utils';

const fetchVendorPage = vi.fn<(slug: string) => Promise<VendorPageRead>>();
vi.mock('@/utils/vendorPage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/vendorPage')>()),
  fetchVendorPage: (slug: string) => fetchVendorPage(slug),
}));

const fetchApplicantApplication = vi.fn();
const resumeSignIn = vi.fn();
const checkInWithDoorCode = vi.fn();
const undoOwnCheckIn = vi.fn();
const checkOutWithDoorCode = vi.fn();
const undoOwnCheckOut = vi.fn();
vi.mock('@/utils/applicantApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/applicantApi')>()),
  fetchApplicantApplication: (...args: unknown[]) => fetchApplicantApplication(...args),
  resumeSignIn: (...args: unknown[]) => resumeSignIn(...args),
  checkInWithDoorCode: (...args: unknown[]) => checkInWithDoorCode(...args),
  undoOwnCheckIn: (...args: unknown[]) => undoOwnCheckIn(...args),
  checkOutWithDoorCode: (...args: unknown[]) => checkOutWithDoorCode(...args),
  undoOwnCheckOut: (...args: unknown[]) => undoOwnCheckOut(...args),
}));

vi.mock('@/utils/publicApplicationForm', () => ({
  fetchPublicApplicationForm: vi.fn(),
}));

/**
 * The page's address: its slug, and a query a test may set, which `replace` changes. Reactive, as
 * the router's is, so a code scanned while the page is open reaches the page's watcher.
 */
const routing = vi.hoisted(() => {
  const held = {
    at: { query: {} as Record<string, string> },
    route: null as unknown as { params: Record<string, string> },
    replace: vi.fn((to: { query: Record<string, string> }) => {
      held.at.query = to.query;
    }),
  };
  return held;
});
vi.mock('vue-router', async () => {
  const { reactive } = await import('vue');
  routing.at = reactive(routing.at);
  routing.route = reactive({
    params: { marketSlug: 'spring-market' } as Record<string, string>,
    get query() {
      return routing.at.query;
    },
    hash: '',
  });
  return {
    useRoute: () => routing.route,
    useRouter: () => ({ push: vi.fn(), replace: routing.replace }),
  };
});

const SESSION_KEY = 'conventioner.applicantSession';
const DOOR_KEY = 'conventioner.doorCode';
const TODAY = calendarToday();
const ANOTHER_DAY = '2099-08-02';
const DOOR_CODE = 'K7M4QP';
const CAME = `${TODAY}T09:41:00+00:00`;
const LEFT = `${TODAY}T16:05:00+00:00`;

/** A Google Form market on its days: its vendors are imported, so the page asks no questions. */
function onItsDays(overrides: Partial<VendorPageInfo> = {}): VendorPageRead {
  return {
    page: {
      marketName: 'Spring Market',
      intakeMode: IntakeMode.Csv,
      phase: MarketPhase.MarketDays,
      takesApplications: false,
      resultsPublished: true,
      marketDates: [TODAY, ANOTHER_DAY].sort(),
      ended: false,
      rememberUntil: null,
      mapOpen: false,
      selfCheckIn: true,
      ...overrides,
    },
    notFound: false,
    failed: false,
  };
}

/** The read as a server from before the switch answered it: no `selfCheckIn` at all. */
function withNoSwitch(): VendorPageRead {
  const read = onItsDays();
  delete read.page!.selfCheckIn;
  return read;
}

function seat(date: string, checkedInAt: string | null = null, checkedOutAt: string | null = null) {
  return {
    date,
    tableCode: 'A 1',
    tableChoice: 'Full Table',
    section: 'A',
    location: 'North Wing',
    checkedInAt,
    checkedOutAt,
  };
}

function seated(...seats: ReturnType<typeof seat>[]): Application {
  return {
    id: 'app-1',
    marketId: 'market-1',
    applicantEmail: 'vendor@example.com',
    status: 'open',
    applicationType: 'main',
    submittedAt: '2099-06-01T00:00:00+00:00',
    updatedAt: '2099-06-01T00:00:00+00:00',
    outcome: 'has_a_table',
    seats,
    vendorName: 'Riley Fixture',
  } as Application;
}

function refusal(status: number, error: string): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const response = { data: { error }, status, statusText: '', headers: {}, config };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, response);
}

function signIn() {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      marketId: 'market-1',
      marketSlug: 'spring-market',
      applicantEmail: 'vendor@example.com',
      token: 'a-token',
    }),
  );
}

/** The page open in this test, closed after it: the address is shared, and a page reads it. */
let open: VueWrapper | null = null;
afterEach(() => {
  open?.unmount();
  open = null;
});

/** The page as the market's read answers it, for whoever the tab holds. */
async function mountPage(read: VendorPageRead) {
  fetchVendorPage.mockResolvedValue(read);
  setActivePinia(createPinia());
  open = mount(VendorPage, { global: { stubs: { RouterLink: RouterLinkStub } } });
  await flushPromises();
  return open;
}

/** The page of a signed-in vendor, the market and their seats as given. */
function pageOf(read: VendorPageRead, ...seats: ReturnType<typeof seat>[]) {
  fetchApplicantApplication.mockResolvedValue(seated(...seats));
  return mountPage(read);
}

type Wrapper = Awaited<ReturnType<typeof pageOf>>;
const at = (testid: string) => `[data-testid="${testid}"]`;
const has = (wrapper: Wrapper, testid: string) => wrapper.find(at(testid)).exists();

/** Every control the card may offer, so a state says which it has and which it has not. */
const CONTROLS = [
  'vendor-check-in-form',
  'vendor-check-in-undo-btn',
  'vendor-check-out-form',
  'vendor-check-out-undo-btn',
];
const controlsOf = (wrapper: Wrapper) => CONTROLS.filter((testid) => has(wrapper, testid));

async function typeCheckOutCode(wrapper: Wrapper, code: string) {
  await wrapper.get(at('vendor-check-out-code-input')).setValue(code);
  await wrapper.get(at('vendor-check-out-form')).trigger('submit');
  await flushPromises();
}

beforeEach(() => {
  sessionStorage.clear();
  routing.at.query = {};
  routing.replace.mockClear();
  for (const mock of [
    fetchVendorPage,
    fetchApplicantApplication,
    checkInWithDoorCode,
    undoOwnCheckIn,
    checkOutWithDoorCode,
    undoOwnCheckOut,
    resumeSignIn,
  ]) {
    mock.mockReset();
  }
  // No remembered sign-in on this device.
  resumeSignIn.mockRejectedValue(refusal(401, 'Sign in with a code.'));
});

describe("today's card, at a market that lets vendors check themselves in and out", () => {
  beforeEach(signIn);

  it('offers only the check-in before one', async () => {
    const wrapper = await pageOf(onItsDays(), seat(TODAY));

    expect(controlsOf(wrapper)).toEqual(['vendor-check-in-form']);
    expect(has(wrapper, 'vendor-check-in-at-door')).toBe(false);
  });

  it('offers the check-out under the check-in and its Undo, with a door code field of its own', async () => {
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    expect(controlsOf(wrapper)).toEqual(['vendor-check-in-undo-btn', 'vendor-check-out-form']);
    expect(wrapper.get(at('vendor-check-in-done')).text()).toBe(
      `Checked in at ${getTimestampTime(CAME)}`,
    );
    const form = wrapper.get(at('vendor-check-out-form'));
    expect(form.get('label').text()).toBe('Door code');
    expect(form.text()).toContain('Type the code under the QR code at the door.');
    const button = wrapper.get(at('vendor-check-out-btn'));
    expect(button.text()).toBe('Check out');
    expect(button.attributes('disabled')).toBeDefined();

    // Disabled until the code is whole.
    await wrapper.get(at('vendor-check-out-code-input')).setValue('k7m');
    expect(button.attributes('disabled')).toBeDefined();
    await wrapper.get(at('vendor-check-out-code-input')).setValue('k7m 4qp');
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('checks them out with a whole door code, then reads when, with one Undo of the check-out', async () => {
    checkOutWithDoorCode.mockResolvedValue({ checkedOutAt: LEFT });
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    await typeCheckOutCode(wrapper, 'k7m 4qp');

    expect(checkOutWithDoorCode).toHaveBeenCalledWith('spring-market', 'a-token', TODAY, 'k7m 4qp');
    expect(wrapper.get(at('vendor-check-in-done')).text()).toBe(
      `Checked in at ${getTimestampTime(CAME)}`,
    );
    const out = wrapper.get(at('vendor-check-out-done'));
    expect(out.text()).toBe(`Checked out at ${getTimestampTime(LEFT)}`);
    expect(out.classes()).toContain('chip--informational');
    // No Undo of the check-in until the check-out is undone.
    expect(controlsOf(wrapper)).toEqual(['vendor-check-out-undo-btn']);

    undoOwnCheckOut.mockResolvedValue(undefined);
    await wrapper.get(at('vendor-check-out-undo-btn')).trigger('click');
    await flushPromises();

    expect(undoOwnCheckOut).toHaveBeenCalledWith('spring-market', 'a-token', TODAY);
    expect(undoOwnCheckIn).not.toHaveBeenCalled();
    expect(has(wrapper, 'vendor-check-out-done')).toBe(false);
    expect(controlsOf(wrapper)).toEqual(['vendor-check-in-undo-btn', 'vendor-check-out-form']);
    // The field is empty again: the code that checked them out is not kept for another.
    expect((wrapper.get(at('vendor-check-out-code-input')).element as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('names the write that is out on its own button, and holds the other still', async () => {
    let answer: (value: { checkedOutAt: string }) => void = () => {};
    checkOutWithDoorCode.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    await typeCheckOutCode(wrapper, DOOR_CODE);

    expect(wrapper.get(at('vendor-check-out-btn')).text()).toBe('Checking out…');
    const undo = wrapper.get(at('vendor-check-in-undo-btn'));
    expect(undo.text()).toBe('Undo');
    expect(undo.attributes('disabled')).toBeDefined();

    answer({ checkedOutAt: LEFT });
    await flushPromises();
    expect(has(wrapper, 'vendor-check-out-done')).toBe(true);
  });

  it('reads a checked-out day as it was stored', async () => {
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME, LEFT));

    expect(has(wrapper, 'vendor-check-in-done')).toBe(true);
    expect(has(wrapper, 'vendor-check-out-done')).toBe(true);
    expect(controlsOf(wrapper)).toEqual(['vendor-check-out-undo-btn']);
  });
});

describe('a refused check-out, or undo of one', () => {
  beforeEach(signIn);

  // The switch turned off between the page's load and the tap.
  it("says the server's sentence in the card's error line, and keeps the code", async () => {
    checkOutWithDoorCode.mockRejectedValue(refusal(403, SELF_CHECK_IN_OFF));
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    await typeCheckOutCode(wrapper, DOOR_CODE);

    expect(wrapper.get(at('vendor-check-in-error')).text()).toBe(SELF_CHECK_IN_OFF);
    expect(has(wrapper, 'vendor-check-out-done')).toBe(false);
    expect((wrapper.get(at('vendor-check-out-code-input')).element as HTMLInputElement).value).toBe(
      DOOR_CODE,
    );
  });

  it('says they were not checked out when the server gave no reason', async () => {
    checkOutWithDoorCode.mockRejectedValue(refusal(409, ''));
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    await typeCheckOutCode(wrapper, DOOR_CODE);

    expect(wrapper.get(at('vendor-check-in-error')).text()).toBe(
      'You were not checked out. Please try again.',
    );
  });

  it("says the server's sentence for a refused undo, the check-out as it was", async () => {
    undoOwnCheckOut.mockRejectedValue(refusal(409, 'Check-in is open on the day itself.'));
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME, LEFT));

    await wrapper.get(at('vendor-check-out-undo-btn')).trigger('click');
    await flushPromises();

    expect(wrapper.get(at('vendor-check-in-error')).text()).toBe(
      'Check-in is open on the day itself.',
    );
    expect(has(wrapper, 'vendor-check-out-done')).toBe(true);
  });

  it('says the check-out was not undone when the server gave no reason', async () => {
    undoOwnCheckOut.mockRejectedValue(refusal(409, ''));
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME, LEFT));

    await wrapper.get(at('vendor-check-out-undo-btn')).trigger('click');
    await flushPromises();

    expect(wrapper.get(at('vendor-check-in-error')).text()).toBe(
      'Your check-out was not undone. Please try again.',
    );
  });

  it('asks for sign-in again when the sign-in ran out, and keeps no code to send by itself', async () => {
    checkOutWithDoorCode.mockRejectedValue(refusal(401, 'Sign in with a code.'));
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    await typeCheckOutCode(wrapper, DOOR_CODE);

    expect(has(wrapper, 'vendor-sign-in-email-input')).toBe(true);
    expect(has(wrapper, 'vendor-page-door-held')).toBe(false);
    expect(sessionStorage.getItem(DOOR_KEY)).toBeNull();
  });
});

describe('a door code scanned by a vendor who is checked in', () => {
  beforeEach(() => {
    signIn();
    routing.at.query = { door: DOOR_CODE };
  });

  // A second scan by accident must never end their day.
  it('is put in the check-out field, and sends nothing', async () => {
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME));

    expect((wrapper.get(at('vendor-check-out-code-input')).element as HTMLInputElement).value).toBe(
      DOOR_CODE,
    );
    expect(wrapper.get(at('vendor-check-out-btn')).attributes('disabled')).toBeUndefined();
    expect(checkOutWithDoorCode).not.toHaveBeenCalled();
    expect(checkInWithDoorCode).not.toHaveBeenCalled();
    expect(has(wrapper, 'vendor-check-out-done')).toBe(false);
    // Taken off the address and out of the tab, as any scanned code is.
    expect(routing.replace).toHaveBeenCalledWith({ query: {}, hash: '' });
    expect(sessionStorage.getItem(DOOR_KEY)).toBeNull();

    checkOutWithDoorCode.mockResolvedValue({ checkedOutAt: LEFT });
    await wrapper.get(at('vendor-check-out-form')).trigger('submit');
    await flushPromises();

    expect(checkOutWithDoorCode).toHaveBeenCalledWith('spring-market', 'a-token', TODAY, DOOR_CODE);
    expect(has(wrapper, 'vendor-check-out-done')).toBe(true);
  });

  it('is dropped once they are checked out', async () => {
    const wrapper = await pageOf(onItsDays(), seat(TODAY, CAME, LEFT));

    expect(checkOutWithDoorCode).not.toHaveBeenCalled();
    expect(checkInWithDoorCode).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(DOOR_KEY)).toBeNull();
    expect(has(wrapper, 'vendor-check-in-notice')).toBe(false);
    expect(controlsOf(wrapper)).toEqual(['vendor-check-out-undo-btn']);

    // Nor does it wait for the check-out's undo, to fill the field then.
    undoOwnCheckOut.mockResolvedValue(undefined);
    await wrapper.get(at('vendor-check-out-undo-btn')).trigger('click');
    await flushPromises();
    expect((wrapper.get(at('vendor-check-out-code-input')).element as HTMLInputElement).value).toBe(
      '',
    );
  });
});

describe.each([
  ['with its switch off', () => onItsDays({ selfCheckIn: false })],
  ['whose read says nothing of a switch', withNoSwitch],
])("today's card, at a market %s", (_name, read) => {
  beforeEach(signIn);

  it('says an organizer checks them in, with no form', async () => {
    const wrapper = await pageOf(read(), seat(TODAY), seat(ANOTHER_DAY));

    expect(controlsOf(wrapper)).toEqual([]);
    expect(wrapper.get(at('vendor-check-in-at-door')).text()).toBe(CHECKED_IN_AT_THE_DOOR);
    // The day and the table as ever, and the other days below.
    const today = wrapper.get(at('vendor-check-in-today'));
    expect(today.text()).toContain('Today');
    expect(today.text()).toContain('North Wing');
    expect(has(wrapper, 'vendor-check-in-done')).toBe(false);
    expect(has(wrapper, 'vendor-check-in-other-days')).toBe(true);
  });

  it('says an organizer checks them out once checked in, with the chip and no Undo', async () => {
    const wrapper = await pageOf(read(), seat(TODAY, CAME));

    expect(controlsOf(wrapper)).toEqual([]);
    expect(has(wrapper, 'vendor-check-in-done')).toBe(true);
    expect(has(wrapper, 'vendor-check-out-done')).toBe(false);
    expect(wrapper.get(at('vendor-check-in-at-door')).text()).toBe(CHECKED_OUT_AT_THE_DOOR);
  });

  it('shows both chips and no line once checked out', async () => {
    const wrapper = await pageOf(read(), seat(TODAY, CAME, LEFT));

    expect(controlsOf(wrapper)).toEqual([]);
    expect(has(wrapper, 'vendor-check-in-done')).toBe(true);
    expect(has(wrapper, 'vendor-check-out-done')).toBe(true);
    expect(has(wrapper, 'vendor-check-in-at-door')).toBe(false);
  });
});

describe('a door code arriving at a market whose switch is off', () => {
  beforeEach(() => {
    routing.at.query = { door: DOOR_CODE };
  });

  it.each([
    ['off', () => onItsDays({ selfCheckIn: false })],
    ['missing from the read', withNoSwitch],
  ])(
    'is dropped before any sign-in, and the page says who checks vendors in (%s)',
    async (_name, read) => {
      const wrapper = await mountPage(read());

      expect(wrapper.get(at('vendor-self-check-in-off')).text()).toBe(SELF_CHECK_IN_OFF);
      expect(has(wrapper, 'vendor-page-door-held')).toBe(false);
      expect(wrapper.text()).not.toContain("you'll be checked in for today");
      expect(has(wrapper, 'vendor-sign-in-email-input')).toBe(true);
      expect(sessionStorage.getItem(DOOR_KEY)).toBeNull();
      expect(routing.replace).toHaveBeenCalledWith({ query: {}, hash: '' });
    },
  );

  it('checks a signed-in vendor in to nothing, and says the same', async () => {
    signIn();
    const wrapper = await pageOf(onItsDays({ selfCheckIn: false }), seat(TODAY));

    expect(wrapper.get(at('vendor-self-check-in-off')).text()).toBe(SELF_CHECK_IN_OFF);
    expect(checkInWithDoorCode).not.toHaveBeenCalled();
    expect(has(wrapper, 'vendor-check-in-notice')).toBe(false);
    expect(sessionStorage.getItem(DOOR_KEY)).toBeNull();
  });

  it('is never kept when scanned again while the page is open', async () => {
    routing.at.query = {};
    signIn();
    const wrapper = await pageOf(onItsDays({ selfCheckIn: false }), seat(TODAY));
    expect(has(wrapper, 'vendor-self-check-in-off')).toBe(false);

    // The router keeps the page, so only the address changes.
    routing.at.query = { door: DOOR_CODE };
    await flushPromises();

    expect(wrapper.get(at('vendor-self-check-in-off')).text()).toBe(SELF_CHECK_IN_OFF);
    expect(routing.at.query).toEqual({});
    expect(sessionStorage.getItem(DOOR_KEY)).toBeNull();
    expect(checkInWithDoorCode).not.toHaveBeenCalled();
  });

  // The phase answers first, as on the server: the switch is set only in market days.
  it('is answered by the phase once the market has ended', async () => {
    signIn();
    const wrapper = await pageOf(
      onItsDays({ phase: MarketPhase.Archived, ended: true, selfCheckIn: false }),
      seat(TODAY),
    );

    expect(has(wrapper, 'vendor-self-check-in-off')).toBe(false);
    expect(wrapper.get(at('vendor-check-in-notice')).text()).toBe(CHECK_IN_ENDED);
  });

  it('checks a vendor in as ever once the switch is on', async () => {
    signIn();
    checkInWithDoorCode.mockResolvedValue({ checkedInAt: CAME });
    const wrapper = await pageOf(onItsDays(), seat(TODAY));

    expect(checkInWithDoorCode).toHaveBeenCalledWith('spring-market', 'a-token', TODAY, DOOR_CODE);
    expect(has(wrapper, 'vendor-self-check-in-off')).toBe(false);
  });
});

describe('the other days, and the record of an ended market', () => {
  beforeEach(signIn);

  it('reads when they checked in and out on a day with both, and the check-in alone before', async () => {
    const wrapper = await pageOf(
      onItsDays(),
      seat('2099-08-01', '2099-08-01T09:41:00+00:00', '2099-08-01T16:05:00+00:00'),
      seat('2099-08-02', '2099-08-02T09:41:00+00:00'),
      seat('2099-08-03'),
    );

    const days = wrapper.findAll(`${at('vendor-check-in-other-days')} li`);
    const came = getTimestampTime('2099-08-01T09:41:00+00:00');
    const left = getTimestampTime('2099-08-01T16:05:00+00:00');
    expect(days[0].text()).toContain(`(checked in at ${came}, checked out at ${left})`);
    expect(days[1].text()).toContain(`(checked in at ${came})`);
    expect(days[1].text()).not.toContain('checked out');
    expect(days[2].text()).not.toContain('checked');
  });

  it('reads both times in the record, the check-in alone, or that they did not check in', async () => {
    const wrapper = await pageOf(
      onItsDays({ phase: MarketPhase.Archived, ended: true }),
      seat('2099-08-01', '2099-08-01T09:41:00+00:00', '2099-08-01T16:05:00+00:00'),
      seat('2099-08-02', '2099-08-02T09:41:00+00:00'),
      seat('2099-08-03'),
    );

    const rows = wrapper.findAll(at('vendor-check-in-record-seat'));
    const came = getTimestampTime('2099-08-01T09:41:00+00:00');
    const left = getTimestampTime('2099-08-01T16:05:00+00:00');
    expect(rows[0].get('.seat-when').text()).toBe(`Checked in at ${came}, checked out at ${left}`);
    expect(rows[1].get('.seat-when').text()).toBe(`Checked in at ${came}`);
    expect(rows[2].get('.seat-when').text()).toBe('Not checked in');
  });
});
