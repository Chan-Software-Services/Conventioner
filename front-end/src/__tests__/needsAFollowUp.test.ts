/**
 * An application can need a follow-up, and someone owns it (E34/F02/S01).
 *
 * Skip recorded nothing. "Needs follow-up" is a stored status with an owner, the reviewer unless
 * they name someone else with a role on the market - explicit or through its organization (T15) -
 * the queue leaves follow-ups out unless asked, and the reviewed list is only what has a verdict.
 *
 * The dialog holds while its parent marks the follow-up, and an answer that lands after the dialog
 * was closed under it stays out of the next opening (T411).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { ApplicationStatus, type Application, type Market } from '@/assets/types/datatypes';
import { followUps, reviewQueue, reviewed } from '@/utils/reviewQueue';
import { useVerdictActions } from '@/utils/verdictActions';
import { PEOPLE_CAP } from '@/utils/personChoice';
import FollowUpDialog from '@/components/application/FollowUpDialog.vue';
import ApplicationMonitor from '@/components/application/ApplicationMonitor.vue';
import { useDialogSubmit } from '@/utils/useDialogSubmit';
import { answeredWith, servedReview } from './support/servedReview';

const fetchMarketApplications = vi.fn();
const reviewApplication = vi.fn();

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  const answered = () => Promise.resolve({ data: {} });
  // The next card handed out is the first still open in the list as last read.
  const post = async (url: string) =>
    url.endsWith('/review/next')
      ? { data: { application: (await fetchMarketApplications())[0] ?? null } }
      : { data: {} };
  return { ...actual, api: { get: answered, post, put: answered, delete: answered } };
});
vi.mock('@/utils/applicantApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/applicantApi')>();
  return {
    ...actual,
    fetchMarketApplications: (id: string) => fetchMarketApplications(id),
    reviewApplication: (...args: unknown[]) => reviewApplication(...args),
  };
});

const app = (
  id: string,
  status: ApplicationStatus,
  submittedAt: string,
  served: ReturnType<typeof servedReview>,
): Application =>
  ({
    id,
    applicantEmail: `${id}@x.test`,
    status,
    submittedAt,
    formData: {},
    ...served,
  }) as Application;

const APPS = [
  app('late', ApplicationStatus.Open, '2026-05-03', servedReview('open')),
  app('chase', ApplicationStatus.NeedsFollowUp, '2026-05-01', servedReview('follow_up')),
  app('early', ApplicationStatus.Open, '2026-05-02', servedReview('open')),
  app('done', ApplicationStatus.ReviewerApproved, '2026-05-01', servedReview('approved')),
  // Stored before the migration at an old spelling of open, which the server serves as open.
  app('old', ApplicationStatus.UnderReview, '2026-05-04', servedReview('open')),
];

describe('the review queue', () => {
  it('leaves follow-ups out unless asked, then takes them after the rest', () => {
    expect(reviewQueue(APPS, false).map((a) => a.id)).toEqual(['early', 'late', 'old']);
    expect(reviewQueue(APPS, true).map((a) => a.id)).toEqual(['early', 'late', 'old', 'chase']);
  });

  it('keeps follow-ups out of what was reviewed', () => {
    expect(reviewed(APPS).map((a) => a.id)).toEqual(['done']);
    expect(followUps(APPS).map((a) => a.id)).toEqual(['chase']);
  });
});

describe('marking a follow-up', () => {
  const PEOPLE = ['alex@market.test', 'sam@market.test'];

  beforeEach(() => localStorage.setItem('user', JSON.stringify('alex@market.test')));
  afterEach(() => localStorage.removeItem('user'));

  function mountDialog(people = PEOPLE, me = 'alex@market.test') {
    return mount(FollowUpDialog, {
      props: {
        open: true,
        applicantEmail: 'nadia@ember.test',
        people,
        me,
        writesNotes: true,
        submission: useDialogSubmit({ opening: () => true, failure: '' }),
      },
      global: { stubs: { teleport: true } },
      attachTo: document.body,
    });
  }

  const field = (wrapper: ReturnType<typeof mountDialog>) =>
    wrapper.get('[data-testid="follow-up-owner-input"]');
  const fieldValue = (wrapper: ReturnType<typeof mountDialog>) =>
    (field(wrapper).element as HTMLInputElement).value;
  const rows = (wrapper: ReturnType<typeof mountDialog>) =>
    wrapper.findAll('[data-testid="follow-up-owner-option"]');
  const submit = (wrapper: ReturnType<typeof mountDialog>) =>
    wrapper.get('[data-testid="follow-up-submit-button"]').element as HTMLButtonElement;

  it('names the reviewer its owner unless they choose someone else, and takes a note', async () => {
    const wrapper = mountDialog();
    expect(fieldValue(wrapper)).toBe('alex@market.test');

    await field(wrapper).setValue('sam');
    await field(wrapper).trigger('keydown', { key: 'Enter' });
    await wrapper.get('[data-testid="follow-up-note"]').setValue('Ask for a portfolio link');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('confirm')?.[0]?.[0]).toEqual({
      ownerEmail: 'sam@market.test',
      note: 'Ask for a portfolio link',
    });
    wrapper.unmount();
  });

  it('is labelled "Who will follow up", and marks the reader’s own address "You"', async () => {
    const wrapper = mountDialog();
    const input = field(wrapper);
    expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toBe('Who will follow up');

    await input.trigger('click');

    expect(rows(wrapper).map((row) => row.attributes('data-value'))).toEqual(PEOPLE);
    expect(rows(wrapper)[0]!.text()).toContain('You');
    expect(rows(wrapper)[1]!.text()).not.toContain('You');
    wrapper.unmount();
  });

  it('finds one of 150 people by typing, draws no more than a page, and sends that address', async () => {
    const everyone = Array.from(
      { length: 150 },
      (_, n) => `person-${String(n + 1).padStart(3, '0')}@market.test`,
    );
    const wrapper = mountDialog(['alex@market.test', ...everyone]);

    await field(wrapper).trigger('click');
    expect(rows(wrapper)).toHaveLength(PEOPLE_CAP);
    expect(wrapper.get('[data-testid="follow-up-owner-more"]').text()).toBe(
      `${151 - PEOPLE_CAP} more, type to narrow`,
    );

    await field(wrapper).setValue('PERSON-142');
    expect(rows(wrapper).map((row) => row.attributes('data-value'))).toEqual([
      'person-142@market.test',
    ]);
    await field(wrapper).trigger('keydown', { key: 'Enter' });
    expect(fieldValue(wrapper)).toBe('person-142@market.test');
    await wrapper.get('form').trigger('submit');

    expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({
      ownerEmail: 'person-142@market.test',
    });
    wrapper.unmount();
  });

  it('never marks a follow-up for no one: words that choose nobody hold the button back', async () => {
    const wrapper = mountDialog();
    expect(submit(wrapper).disabled).toBe(false);

    await field(wrapper).setValue('sam');
    expect(submit(wrapper).disabled).toBe(true);

    await field(wrapper).trigger('keydown', { key: 'Enter' });
    expect(submit(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });

  it('closes its list on Escape before the dialog hears the key', async () => {
    const wrapper = mountDialog();

    await field(wrapper).trigger('click');
    expect(wrapper.find('[data-testid="follow-up-owner-list"]').exists()).toBe(true);
    await field(wrapper).trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[data-testid="follow-up-owner-list"]').exists()).toBe(false);
    expect(wrapper.emitted('close')).toBeUndefined();

    await field(wrapper).trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('opens on the field with the address selected, so typing searches rather than adds to it', async () => {
    const wrapper = mountDialog();
    await nextTick();
    await nextTick();
    const input = field(wrapper).element as HTMLInputElement;

    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    wrapper.unmount();
  });

  it('names the address it will send even when the read offers no one', () => {
    const wrapper = mountDialog([]);

    expect(fieldValue(wrapper)).toBe('alex@market.test');
    expect(submit(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });

  it('offers everyone the market read serves, the organization’s people too', () => {
    setActivePinia(createPinia());
    // The market's roles name only its owner; the organization admin reviewing is among the
    // people the server says may own a follow-up.
    const market = ref({
      roles: { 'user-alex': 'owner' },
      peopleOnMarket: ['alex@market.test', 'robin@org.test'],
    } as unknown as Market);

    const { people } = useVerdictActions(market, ref([]));

    expect(people.value).toEqual(['alex@market.test', 'robin@org.test']);
  });

  it('names an organization admin reviewing its owner, not the market’s owner', () => {
    const wrapper = mountDialog(['alex@market.test', 'robin@org.test'], 'robin@org.test');

    expect(fieldValue(wrapper)).toBe('robin@org.test');
    wrapper.unmount();
  });
});

describe('marking a follow-up on the card', () => {
  const MARKET = {
    id: 'm1',
    applicationForm: { fields: [] },
    reviewHighlights: [],
    peopleOnMarket: ['alex@market.test'],
    actionRefusals: { 'give-verdicts': null, 'change-verdicts': null },
  } as unknown as Market;
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    localStorage.setItem('user', JSON.stringify('alex@market.test'));
    fetchMarketApplications
      .mockReset()
      .mockResolvedValue([
        app('early', ApplicationStatus.Open, '2026-05-02', servedReview('open')),
      ]);
    reviewApplication.mockReset();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    localStorage.removeItem('user');
  });

  const page = () => new DOMWrapper(document.body);
  const byId = (id: string) => page().find(`[data-testid="${id}"]`);

  async function askForAFollowUp() {
    wrapper ??= mount(ApplicationMonitor, {
      props: { market: MARKET, visible: true },
      attachTo: document.body,
    });
    await flushPromises();
    await byId('app-monitor-follow-up-button').trigger('click');
    await flushPromises();
    return wrapper;
  }

  /** The next verdict's answer, held until the test refuses or answers it. */
  function holdTheVerdict() {
    let answer!: () => void;
    let refuse!: (reason: unknown) => void;
    reviewApplication.mockImplementationOnce(
      (_m: string, held: Application, status: string) =>
        new Promise((resolve, reject) => {
          answer = () => resolve({ application: answeredWith(held, status), undoSeconds: 0 });
          refuse = reject;
        }),
    );
    return { answer: () => answer(), refuse: (reason: unknown) => refuse(reason) };
  }

  const markIt = () => page().get('[data-testid="follow-up-window"] form').trigger('submit');

  it('holds while it marks, and marks once however often it is pressed', async () => {
    await askForAFollowUp();
    const verdict = holdTheVerdict();

    await markIt();
    await markIt();
    await flushPromises();
    await byId('follow-up-close-button').trigger('click');
    await byId('follow-up-background').trigger('click');
    await byId('follow-up-cancel-button').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(byId('follow-up-window').exists()).toBe(true);
    expect(byId('follow-up-submit-button').attributes('disabled')).toBeDefined();
    expect(reviewApplication).toHaveBeenCalledTimes(1);

    verdict.answer();
    await flushPromises();
    expect(byId('follow-up-window').exists()).toBe(false);
  });

  it('keeps a refusal that lands after the review was left out of the next opening', async () => {
    const monitor = await askForAFollowUp();
    const verdict = holdTheVerdict();
    await markIt();
    await flushPromises();

    // Leaving the review takes the dialog with the card it lay over.
    await monitor.setProps({ visible: false });
    await flushPromises();
    verdict.refuse({
      isAxiosError: true,
      response: { status: 403, data: { error: 'The server said no.' } },
    });
    await flushPromises();
    await monitor.setProps({ visible: true });
    await flushPromises();
    expect(byId('follow-up-window').exists()).toBe(false);

    await askForAFollowUp();

    expect(byId('follow-up-window').exists()).toBe(true);
    expect(byId('follow-up-error').exists()).toBe(false);
    expect(byId('follow-up-submit-button').attributes('disabled')).toBeUndefined();
  });
});
