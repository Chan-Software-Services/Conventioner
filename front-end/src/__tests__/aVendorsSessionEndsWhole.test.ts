// @vitest-environment happy-dom
/**
 * A vendor's sign-in is one thing, and a sign-out ends it whole (T421, T277 ticket 11).
 *
 * On a shared door device, a vendor signs out while a read, a save or a check-in of theirs is
 * still out. That answer, landing after, put their application back on the page the next person
 * opens, kept their answers to be sent after the next sign-in, or, as a 401, signed the next
 * vendor out. The store notes the sign-in each request was made in, and a request that answers
 * after it ended writes nothing and has nothing to show or say.
 *
 * Each request's status is its own answer and its caller's: the store's one shared `loading`,
 * which turned false when any request answered, is gone, and the form's "Saving…" is its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';

const applicantApi = vi.hoisted(() => ({
  requestLoginCode: vi.fn(),
  verifyLoginCode: vi.fn(),
  resumeSignIn: vi.fn(),
  endRememberedSignIn: vi.fn(),
  fetchApplicantApplication: vi.fn(),
  saveApplicantApplication: vi.fn(),
  checkInWithDoorCode: vi.fn(),
  undoOwnCheckIn: vi.fn(),
}));
vi.mock('@/utils/applicantApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/applicantApi')>()),
  ...applicantApi,
}));

const fetchPublicApplicationForm = vi.fn();
vi.mock('@/utils/publicApplicationForm', () => ({
  fetchPublicApplicationForm: (slug: string) => fetchPublicApplicationForm(slug),
}));

import { useApplicationStore } from '@/stores/application';
import VendorApplicationForm from '@/components/vendorPage/VendorApplicationForm.vue';
import { IntakeMode, MarketPhase, type Application } from '@/assets/types/datatypes';
import { EMPTY_ESSENTIAL_OPTIONS } from '@/utils/essentialFields';

const SESSION_KEY = 'conventioner.applicantSession';
const DRAFT_KEY = 'conventioner.applicationDraft';

const ANA = {
  marketId: 'market-1',
  marketSlug: 'spring-market',
  applicantEmail: 'ana@example.com',
  token: 'ana-token',
};
const BEN = { success: true, marketId: 'market-1', applicantEmail: 'ben@example.com' };

function application(email: string, overrides: Partial<Application> = {}): Application {
  return {
    id: `app-${email}`,
    marketId: 'market-1',
    applicantEmail: email,
    formData: { essential_full_name: 'Riley Fixture', business_name: 'Fixture Goods' },
    status: 'open',
    applicationType: 'main',
    submittedAt: '2099-06-01T00:00:00+00:00',
    updatedAt: '2099-06-01T00:00:00+00:00',
    outcome: null,
    seats: [{ date: '2099-08-01', checkedInAt: null }],
    vendorName: 'Riley Fixture',
    ...overrides,
  } as Application;
}

/** An answer the test settles when it chooses. */
function held<T>() {
  let settle!: (value: T) => void;
  let refuse!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    refuse = reject;
  });
  return { promise, settle, refuse };
}

function unauthorized(): AxiosError {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const response = {
    data: { message: 'Sign in with a code.' },
    status: 401,
    statusText: 'UNAUTHORIZED',
    headers: {},
    config,
  };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, response);
}

function anaSignedIn() {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(ANA));
  setActivePinia(createPinia());
  return useApplicationStore();
}

/** Ana signs out, and the server takes it: her remembered sign-in is ended too. */
async function anaSignsOut(store: ReturnType<typeof useApplicationStore>) {
  expect(await store.signOut('spring-market')).toBe(true);
  expect(store.token).toBeNull();
}

function expectNobodySignedIn(store: ReturnType<typeof useApplicationStore>) {
  expect(store.marketId).toBeNull();
  expect(store.marketSlug).toBeNull();
  expect(store.applicantEmail).toBeNull();
  expect(store.token).toBeNull();
  expect(store.application).toBeNull();
  expect(store.error).toBeNull();
  expect(store.draft).toBeNull();
  expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
}

beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  applicantApi.endRememberedSignIn.mockResolvedValue(undefined);
  // No remembered sign-in once signed out.
  applicantApi.resumeSignIn.mockRejectedValue(unauthorized());
  fetchPublicApplicationForm.mockResolvedValue({
    fields: [],
    essentialOptions: EMPTY_ESSENTIAL_OPTIONS,
    failed: false,
    notFound: false,
  });
});

describe('a request answering after the vendor signed out', () => {
  it('puts no application back on the shared device (probe 13)', async () => {
    const store = anaSignedIn();
    const read = held<Application>();
    applicantApi.fetchApplicantApplication.mockReturnValue(read.promise);

    const reading = store.fetchApplication();
    await anaSignsOut(store);
    read.settle(application(ANA.applicantEmail));

    expect(await reading).toEqual({ application: null, failed: false });
    expectNobodySignedIn(store);
  });

  it('says no failure of the read the vendor left', async () => {
    const store = anaSignedIn();
    const read = held<Application>();
    applicantApi.fetchApplicantApplication.mockReturnValue(read.promise);

    const reading = store.fetchApplication();
    await anaSignsOut(store);
    read.refuse(new Error('Network Error'));

    expect(await reading).toEqual({ application: null, failed: false });
    expectNobodySignedIn(store);
  });

  it("puts back none of the page's questions with the vendor's read", async () => {
    const store = anaSignedIn();
    store.page = {
      marketName: 'Spring Market',
      intakeMode: IntakeMode.Form,
      phase: MarketPhase.Applications,
      takesApplications: true,
      resultsPublished: false,
      marketDates: ['2099-08-01'],
      ended: false,
      rememberUntil: '2099-08-01',
      mapOpen: false,
    };
    const read = held<Application>();
    applicantApi.fetchApplicantApplication.mockReturnValue(read.promise);
    fetchPublicApplicationForm.mockResolvedValue({
      fields: [{ key: 'business_name', label: 'Business name', type: 'text', options: [] }],
      essentialOptions: EMPTY_ESSENTIAL_OPTIONS,
      failed: false,
      notFound: false,
    });

    const reading = store.loadVendorRead();
    await anaSignsOut(store);
    read.settle(application(ANA.applicantEmail));

    expect(await reading).toEqual({ failed: false, notFound: false });
    expect(store.formFields).toEqual([]);
    expectNobodySignedIn(store);
  });

  it('keeps none of the answers it sent, to be saved after the next sign-in', async () => {
    const store = anaSignedIn();
    const save = held<Application>();
    applicantApi.saveApplicantApplication.mockReturnValue(save.promise);

    const saving = store.saveApplication({ business_name: 'Fixture Goods' });
    await anaSignsOut(store);
    save.refuse(unauthorized());

    expect(await saving).toBeNull();
    expectNobodySignedIn(store);
  });

  it('puts back no application a save answered with', async () => {
    const store = anaSignedIn();
    const save = held<Application>();
    applicantApi.saveApplicantApplication.mockReturnValue(save.promise);

    const saving = store.saveApplication({ business_name: 'Fixture Goods' });
    await anaSignsOut(store);
    save.settle(application(ANA.applicantEmail));

    expect(await saving).toBeNull();
    expectNobodySignedIn(store);
  });

  it('marks no check-in, says nothing and keeps nothing for the next sign-in', async () => {
    const store = anaSignedIn();
    store.application = application(ANA.applicantEmail);
    const checking = held<{ checkedInAt: string }>();
    applicantApi.checkInWithDoorCode.mockReturnValue(checking.promise);

    const checkIn = store.checkIn('2099-08-01', 'DOOR-CODE');
    await anaSignsOut(store);
    checking.settle({ checkedInAt: '2099-08-01T09:00:00Z' });

    // Not "your sign-in ended": that answer has the section keep a scanned code for the vendor's
    // next sign-in, and Ana signed out.
    expect(await checkIn).toEqual({ ok: false, message: '', signedOut: false });
    expectNobodySignedIn(store);
  });

  it('says nothing of an undo refused after the vendor left', async () => {
    const store = anaSignedIn();
    const undoing = held<unknown>();
    applicantApi.undoOwnCheckIn.mockReturnValue(undoing.promise);

    const undo = store.undoCheckIn('2099-08-01');
    await anaSignsOut(store);
    undoing.refuse(unauthorized());

    expect(await undo).toEqual({ ok: false, message: '', signedOut: false });
    expectNobodySignedIn(store);
  });

  it('never signs the next vendor out, nor lands on their page', async () => {
    const store = anaSignedIn();
    const anasRead = held<Application>();
    applicantApi.fetchApplicantApplication.mockReturnValueOnce(anasRead.promise);
    const anasSave = held<Application>();
    applicantApi.saveApplicantApplication.mockReturnValueOnce(anasSave.promise);

    const reading = store.fetchApplication();
    const saving = store.saveApplication({ business_name: 'Fixture Goods' });
    await anaSignsOut(store);
    applicantApi.verifyLoginCode.mockResolvedValue({ ...BEN, token: 'ben-token' });
    expect(
      await store.verifyCode(
        'spring-market',
        BEN.applicantEmail,
        '123456',
        false,
        'a-human-check-token',
      ),
    ).toEqual({
      ok: true,
    });
    anasRead.refuse(unauthorized());
    anasSave.settle(application(ANA.applicantEmail));
    await reading;
    await saving;

    expect(store.applicantEmail).toBe(BEN.applicantEmail);
    expect(store.token).toBe('ben-token');
    expect(store.application).toBeNull();
    expect(store.error).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null')).toMatchObject({
      applicantEmail: BEN.applicantEmail,
      token: 'ben-token',
    });
  });

  it("never renews into the next vendor's remembered sign-in and sends with it", async () => {
    const store = anaSignedIn();
    const anasSave = held<Application>();
    applicantApi.saveApplicantApplication.mockReturnValueOnce(anasSave.promise);

    const saving = store.saveApplication({ business_name: "Ana's answers" });
    await anaSignsOut(store);
    applicantApi.verifyLoginCode.mockResolvedValue({ ...BEN, token: 'ben-token' });
    await store.verifyCode(
      'spring-market',
      BEN.applicantEmail,
      '123456',
      true,
      'a-human-check-token',
    );
    // The device remembers Ben now; Ana's ended save is not renewed at all.
    applicantApi.resumeSignIn.mockResolvedValue({ ...BEN, token: 'ben-renewed' });
    anasSave.refuse(unauthorized());

    expect(await saving).toBeNull();
    expect(applicantApi.resumeSignIn).not.toHaveBeenCalled();
    expect(applicantApi.saveApplicantApplication).toHaveBeenCalledTimes(1);
    expect(store.token).toBe('ben-token');
  });
});

describe('a sign-in renewed from a remembered device', () => {
  it('keeps the request it renews, which lands', async () => {
    const store = anaSignedIn();
    applicantApi.fetchApplicantApplication
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce(application(ANA.applicantEmail));
    applicantApi.resumeSignIn.mockResolvedValue({
      success: true,
      marketId: ANA.marketId,
      applicantEmail: ANA.applicantEmail,
      token: 'ana-renewed',
    });

    const read = await store.fetchApplication();

    expect(read.application?.applicantEmail).toBe(ANA.applicantEmail);
    expect(store.application?.applicantEmail).toBe(ANA.applicantEmail);
    expect(store.token).toBe('ana-renewed');
    expect(applicantApi.fetchApplicantApplication).toHaveBeenLastCalledWith(
      'spring-market',
      'ana-renewed',
    );
  });

  // The device's remembered sign-in is the market's, not this tab's, and another tab signed Ben in
  // with "Remember me": a renewal of Ana's that brings back Ben is refused.
  it("never sends a save again with another vendor's remembered sign-in", async () => {
    const store = anaSignedIn();
    applicantApi.saveApplicantApplication.mockImplementation((_slug: string, token: string) =>
      token === 'ben-remembered'
        ? Promise.resolve(application(BEN.applicantEmail))
        : Promise.reject(unauthorized()),
    );
    applicantApi.resumeSignIn.mockResolvedValue({ ...BEN, token: 'ben-remembered' });

    expect(await store.saveApplication({ business_name: "Ana's answers" })).toBeNull();

    expect(applicantApi.saveApplicantApplication).toHaveBeenCalledTimes(1);
    expect(applicantApi.saveApplicantApplication).not.toHaveBeenCalledWith(
      'spring-market',
      'ben-remembered',
      expect.anything(),
    );
    expect(store.token).toBeNull();
    expect(store.applicantEmail).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    // Ana's answers wait for Ana's next sign-in, as after any sign-in that could not be renewed.
    expect(store.draftFor('spring-market', ANA.applicantEmail)?.saveAfterSignIn).toBe(true);
    expect(store.draftFor('spring-market', BEN.applicantEmail)).toBeNull();
    expect(store.error).toBe(
      'Your session has expired. Sign in again, and your answers will be saved.',
    );
  });

  it("never shows another vendor's application on a read renewed into their sign-in", async () => {
    const store = anaSignedIn();
    // The server answers Ben's application to Ben's sign-in alone.
    applicantApi.fetchApplicantApplication.mockImplementation((_slug: string, token: string) =>
      token === 'ben-remembered'
        ? Promise.resolve(application(BEN.applicantEmail))
        : Promise.reject(unauthorized()),
    );
    applicantApi.resumeSignIn.mockResolvedValue({ ...BEN, token: 'ben-remembered' });

    expect(await store.fetchApplication()).toEqual({ application: null, failed: false });

    expect(applicantApi.fetchApplicantApplication).toHaveBeenCalledTimes(1);
    expect(store.application).toBeNull();
    expect(store.token).toBeNull();
    expect(store.applicantEmail).toBeNull();
  });
});

describe('a sign-in that replaces another vendor in this tab', () => {
  it("lands nothing of the vendor it replaced, on the next one's page", async () => {
    const store = anaSignedIn();
    const anasSave = held<Application>();
    applicantApi.saveApplicantApplication.mockReturnValueOnce(anasSave.promise);

    const saving = store.saveApplication({ business_name: "Ana's answers" });
    // Ben signs in on another market's page in this tab, with no sign-out between.
    applicantApi.verifyLoginCode.mockResolvedValue({
      ...BEN,
      marketId: 'market-2',
      token: 'ben-token',
    });
    await store.verifyCode(
      'autumn-market',
      BEN.applicantEmail,
      '123456',
      false,
      'a-human-check-token',
    );
    anasSave.settle(application(ANA.applicantEmail));

    expect(await saving).toBeNull();
    expect(store.application).toBeNull();
    expect(store.applicantEmail).toBe(BEN.applicantEmail);
    expect(store.token).toBe('ben-token');
  });
});

describe('a sign-in that ended on the server', () => {
  it('is cleared whole, once, and said', async () => {
    const store = anaSignedIn();
    applicantApi.fetchApplicantApplication.mockRejectedValue(unauthorized());

    expect(await store.fetchApplication()).toEqual({ application: null, failed: false });

    expect(store.marketId).toBeNull();
    expect(store.marketSlug).toBeNull();
    expect(store.applicantEmail).toBeNull();
    expect(store.token).toBeNull();
    expect(store.error).toBe('Your session has expired. Please sign in again.');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});

describe("the form's Save (probe 14)", () => {
  it('stays on "Saving…" while a read answers, until the save does', async () => {
    const store = anaSignedIn();
    applicantApi.fetchApplicantApplication.mockResolvedValueOnce(application(ANA.applicantEmail));
    await store.fetchApplication();
    store.formFields = [
      {
        key: 'business_name',
        label: 'Business name',
        type: 'text',
        required: true,
        options: [],
        order: 0,
      },
    ];
    const wrapper = mount(VendorApplicationForm);
    await flushPromises();
    const save = held<Application>();
    applicantApi.saveApplicantApplication.mockReturnValue(save.promise);
    const read = held<Application>();
    applicantApi.fetchApplicantApplication.mockReturnValue(read.promise);
    const submit = () => wrapper.get('[data-testid="apply-submit-button"]');

    const reading = store.fetchApplication();
    await wrapper.get('[data-testid="apply-form"]').trigger('submit');
    expect(submit().text()).toBe('Saving…');
    read.settle(application(ANA.applicantEmail));
    await reading;
    await flushPromises();

    expect(submit().text()).toBe('Saving…');
    expect(submit().attributes('disabled')).toBeDefined();
    expect(wrapper.emitted('saved')).toBeUndefined();

    save.settle(application(ANA.applicantEmail));
    await flushPromises();

    expect(submit().text()).toBe('Save application');
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });
});
