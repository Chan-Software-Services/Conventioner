/**
 * The form tab sends one whole-form save at a time (T420).
 *
 * "Ask this" saves the whole form as it is ticked, and Save Form saves it too. Only Save Form used
 * to be refused while a save was out, so two quick ticks, or a tick while Save Form was out, put two
 * whole-form `PUT`s out at once carrying the same `formRevision`: the server refused the second as
 * "the market changed", and the tab read the form again, dropping the questions not yet saved.
 * Both now go through one autosave with no pause: a tick shows at once, and while a save is out it
 * is sent when that save answers, at the revision the answer carried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { AxiosError } from 'axios';
import { createPinia, setActivePinia } from 'pinia';

import MarketSetupView from '@/views/MarketSetupView.vue';
import MarketFormTab from '@/components/market/MarketFormTab.vue';
import FormBuilder from '@/components/application/FormBuilder.vue';
import EssentialFieldsPanel from '@/components/application/EssentialFieldsPanel.vue';
import type { ApplicationForm, FormField } from '@/assets/types/datatypes';
import { MARKET_CHANGED_CODE } from '@/utils/api';
import { useMarketStore } from '@/stores/market';
import { MARKET_ID, marketRoute, marketRouter, serveMarket } from './support/marketScreen';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
/** What the application-form endpoint answers; the market is served by `GET /markets/:id`. */
const formApi = vi.hoisted(() => vi.fn());

vi.mock('vue-router', () => ({
  useRouter: () => marketRouter(),
  useRoute: () => marketRoute('form'),
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn(),
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const FORM_URL = `/markets/${MARKET_ID}/application-form`;
const SENTENCE =
  'This market changed while you were working on it, so your change was not saved. ' +
  'Reload to see the latest, then make your change again.';
const LOCK = 'Only while the market is in draft phase.';

function field(key: string, label: string, order: number): FormField {
  return { key, label, type: 'text', required: false, options: [], order };
}
const SHOP = field('shop_name', 'Shop', 0);
const WEBSITE = field('website', 'Website', 1);

function form(fields: FormField[], unaskedEssentials: string[] = []): ApplicationForm {
  return { fields, unaskedEssentials };
}

function formRead(applicationForm: ApplicationForm, formRevision: number) {
  return { data: { application_form: applicationForm, essential_options: null, formRevision } };
}

function serve(applicationForm: ApplicationForm, applicationFormLockReason: string | null = null) {
  serveMarket(
    api.get,
    {
      id: MARKET_ID,
      name: 'Riverside',
      setupObject: {
        priority: [],
        marketDates: [],
        tiers: [],
        locations: [],
        sections: [],
        assignmentOptions: {},
      },
      applicationForm,
      applicationFormLockReason,
    },
    (url) => formApi(url),
  );
}

async function mountOnFormTab() {
  const wrapper = mount(MarketSetupView, {
    shallow: true,
    global: {
      stubs: {
        MarketFrame: false,
        MarketFormTab: false,
        StepHeader: false,
        ElementSettingContainer: {
          template: '<div><slot name="setting-title" /><slot name="setting-content" /></div>',
        },
      },
    },
  });
  await vi.waitFor(() => expect(wrapper.findComponent(MarketFormTab).exists()).toBe(true));
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountOnFormTab>>;

type Sent = ApplicationForm & { formRevision: number };

/**
 * `PUT`s whose answers the test holds, counting how many were out at once. An answer stores what
 * was sent at the next revision; a refusal or a failure is what the test rejects it with.
 */
function heldPuts() {
  let out = 0;
  let most = 0;
  const pending: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  api.put.mockImplementation(
    (_url: string, body: Sent) =>
      new Promise((resolve, reject) => {
        out += 1;
        most = Math.max(most, out);
        pending.push({
          resolve: () => {
            out -= 1;
            const { formRevision, ...stored } = body;
            resolve({ data: { application_form: stored, formRevision: formRevision + 1 } });
          },
          reject: (err) => {
            out -= 1;
            reject(err);
          },
        });
      }),
  );
  return {
    most: () => most,
    out: () => out,
    answer: async () => {
      pending.shift()!.resolve();
      await flushPromises();
    },
    refuse: async (err: unknown) => {
      pending.shift()!.reject(err);
      await flushPromises();
    },
  };
}

const sent = (): Sent[] => api.put.mock.calls.map(([, body]) => body as Sent);
const formReads = () => formApi.mock.calls.filter(([url]) => url === FORM_URL).length;

function panel(wrapper: Wrapper) {
  return wrapper.findComponent(EssentialFieldsPanel);
}
async function tick(wrapper: Wrapper, key: string, unasked = true) {
  panel(wrapper).vm.$emit('toggleUnasked', key, unasked);
  await flushPromises();
}
const unaskedShown = (wrapper: Wrapper) => panel(wrapper).props('options').unasked ?? [];

async function openStep(wrapper: Wrapper, step: 'essentials' | 'questions') {
  await wrapper.get(`[data-testid="form-step-${step}"]`).trigger('click');
  await flushPromises();
}
async function editQuestions(wrapper: Wrapper, edited: ApplicationForm) {
  wrapper.findComponent(FormBuilder).vm.$emit('update:applicationForm', edited);
  await flushPromises();
}
const questionsShown = (wrapper: Wrapper) =>
  (wrapper.findComponent(FormBuilder).props('applicationForm') as ApplicationForm).fields.map(
    (f) => f.key,
  );

function marketChanged() {
  return Object.assign(new AxiosError('refused'), {
    response: { status: 409, data: { error: SENTENCE, code: MARKET_CHANGED_CODE } },
  });
}
function offline() {
  return Object.assign(new AxiosError('Network Error'), { code: 'ERR_NETWORK' });
}

beforeEach(() => {
  setActivePinia(createPinia());
  formApi.mockReset();
  api.get.mockReset();
  api.put.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('the form tab sends one whole-form save at a time', () => {
  it('sends a second quick tick when the first answers, at its revision, with both choices', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();

    await tick(wrapper, 'a');
    // The box stays as ticked while its save is out.
    expect(unaskedShown(wrapper)).toEqual(['a']);
    await tick(wrapper, 'b');
    expect(unaskedShown(wrapper)).toEqual(['a', 'b']);
    expect(puts.out()).toBe(1);

    await puts.answer();
    expect(puts.out()).toBe(1);
    await puts.answer();

    expect(puts.most()).toBe(1);
    expect(sent().map((body) => body.formRevision)).toEqual([4, 5]);
    expect(sent().map((body) => body.unaskedEssentials)).toEqual([['a'], ['a', 'b']]);
    expect(api.put.mock.calls.every(([url]) => url === FORM_URL)).toBe(true);
    expect(unaskedShown(wrapper)).toEqual(['a', 'b']);
    expect(wrapper.get('[data-testid="form-builder-save-success"]').text()).toBe('Saved');
  });

  it('sends a tick made while Save Form is out when it answers, with the questions it saved', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();
    await openStep(wrapper, 'questions');
    await editQuestions(wrapper, form([SHOP, WEBSITE]));
    await wrapper.get('[data-testid="form-builder-save-button"]').trigger('click');
    await flushPromises();
    // Save Form says it is saving, and cannot start a second save.
    const button = wrapper.get('[data-testid="form-builder-save-button"]');
    expect(button.text()).toBe('Saving...');
    expect(button.attributes('disabled')).toBeDefined();

    await openStep(wrapper, 'essentials');
    await tick(wrapper, 'a');
    expect(puts.out()).toBe(1);
    expect(unaskedShown(wrapper)).toEqual(['a']);

    await puts.answer();
    // The tick is not lost to the questions' answer, which did not carry it.
    expect(unaskedShown(wrapper)).toEqual(['a']);
    await puts.answer();

    expect(puts.most()).toBe(1);
    expect(sent().map((body) => body.formRevision)).toEqual([4, 5]);
    expect(sent()[1].fields.map((f) => f.key)).toEqual(['shop_name', 'website']);
    expect(sent()[1].unaskedEssentials).toEqual(['a']);
    await openStep(wrapper, 'questions');
    expect(questionsShown(wrapper)).toEqual(['shop_name', 'website']);
  });

  it('a tick never sends questions not yet saved', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();
    await openStep(wrapper, 'questions');
    await editQuestions(wrapper, form([SHOP, WEBSITE]));
    await openStep(wrapper, 'essentials');

    await tick(wrapper, 'a');
    await puts.answer();

    expect(sent()[0].fields.map((f) => f.key)).toEqual(['shop_name']);
    await openStep(wrapper, 'questions');
    expect(questionsShown(wrapper)).toEqual(['shop_name', 'website']);
  });

  it('a tick refused as the market changed reads the form again, as Save Form does, and says why', async () => {
    serve(form([SHOP]));
    formApi
      .mockResolvedValueOnce(formRead(form([SHOP]), 4))
      .mockResolvedValue(formRead(form([SHOP, WEBSITE]), 5));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();

    await tick(wrapper, 'a');
    await puts.refuse(marketChanged());

    expect(formReads()).toBe(2);
    expect(wrapper.get('[data-testid="form-builder-save-error"]').text()).toBe(SENTENCE);
    expect(unaskedShown(wrapper)).toEqual([]);
    // The next tick stands on the form read again.
    await tick(wrapper, 'b');
    expect(wrapper.find('[data-testid="form-builder-save-error"]').exists()).toBe(false);
    await puts.answer();
    expect(sent().map((body) => body.formRevision)).toEqual([4, 5]);
    expect(sent()[1].fields.map((f) => f.key)).toEqual(['shop_name', 'website']);
  });

  it('a failed tick puts the box back, says why and keeps the questions not yet saved', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();
    await openStep(wrapper, 'questions');
    await editQuestions(wrapper, form([SHOP, WEBSITE]));
    await openStep(wrapper, 'essentials');

    await tick(wrapper, 'a');
    await tick(wrapper, 'b');
    await puts.refuse(offline());

    // The tick waiting behind it is dropped with it: the tab has no Retry.
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(unaskedShown(wrapper)).toEqual([]);
    expect(wrapper.get('[data-testid="form-builder-save-error"]').text()).not.toBe('');
    expect(formReads()).toBe(1);
    await openStep(wrapper, 'questions');
    expect(questionsShown(wrapper)).toEqual(['shop_name', 'website']);
  });

  it('a tick with no sentence of its own says the form was not saved', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();

    await tick(wrapper, 'a');
    await puts.refuse(new Error('boom'));

    expect(wrapper.get('[data-testid="form-builder-save-error"]').text()).toBe(
      'The form was not saved.',
    );
  });

  it('drops a waiting tick when the form locks while the save before it is out', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();

    await tick(wrapper, 'a');
    await tick(wrapper, 'b');
    // Applications open in another tab, and the store re-reads the market; the tab's read of the
    // locked form answers after the save out does.
    serve(form([SHOP]), LOCK);
    let answerRead: () => void = () => {};
    formApi.mockReturnValue(
      new Promise((resolve) => (answerRead = () => resolve(formRead(form([SHOP], ['a']), 5)))),
    );
    await useMarketStore().refresh();
    await flushPromises();
    await puts.answer();

    expect(api.put).toHaveBeenCalledTimes(1);
    expect(sent()[0].unaskedEssentials).toEqual(['a']);
    // The waiting tick is off the screen at once, not only once the form is read again.
    expect(unaskedShown(wrapper)).toEqual(['a']);
    answerRead();
    await flushPromises();
    expect(unaskedShown(wrapper)).toEqual(['a']);
  });

  it('sends a waiting tick when the tab is left', async () => {
    serve(form([SHOP]));
    formApi.mockResolvedValue(formRead(form([SHOP]), 4));
    const puts = heldPuts();
    const wrapper = await mountOnFormTab();

    await tick(wrapper, 'a');
    await tick(wrapper, 'b');
    wrapper.unmount();
    await puts.answer();

    expect(api.put).toHaveBeenCalledTimes(2);
    expect(sent()[1]).toMatchObject({ formRevision: 5, unaskedEssentials: ['a', 'b'] });
  });
});
