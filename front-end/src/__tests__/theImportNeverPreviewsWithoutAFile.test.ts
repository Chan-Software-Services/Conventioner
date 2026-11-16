/**
 * The CSV import never previews without a file (T419, T277 probe 6).
 *
 * On Map columns, "Preview import" sends the values check. Back was offered while it was out and
 * started over, dropping the file, and the check's late answer then moved the page from Upload to
 * Preview with no file, whose Import posted an empty `csvContent`. A form read sent by "Add a
 * question for it" answered the same way, opening the amend dialog over Upload.
 * Back now waits while the values check, a re-read of the questions or the import is out, and
 * Start over drops every answer still to come, the form read's included.
 * The steps carry their data (`utils/importWizard`): a change made during the check withdraws it,
 * and a file the server could not read is not named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

import CsvImportView from '@/views/CsvImportView.vue';
import { IntakeMode, MarketPhase, type Market } from '@/assets/types/datatypes';
import { answerLeaveQuestion } from '@/utils/useUnsavedWork';
import { answersRefusing } from './support/servedAnswers';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const open = vi.hoisted(() => ({ market: null as unknown, refresh: vi.fn() }));

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: { marketId: 'market-1' } }),
  onBeforeRouteLeave: () => {},
  onBeforeRouteUpdate: () => {},
}));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});
vi.mock('@/utils/openMarket', () => ({
  useOpenMarket: () => ({ market: open.market, status: ref('ready'), refresh: open.refresh }),
}));

/** A market in Review, so the confirm posts the import with no reviewers write before it. */
const MARKET = {
  id: 'market-1',
  name: 'Riverside',
  phase: MarketPhase.Applications,
  intakeMode: IntakeMode.Csv,
  actionRefusals: answersRefusing(),
  reviewTeam: { reviewers: [] },
  reviewerCandidates: [],
} as unknown as Market;

const FILE = 'Email Address\nana-vendor@example.com';

let valuesCheck: PromiseWithResolvers<unknown>;

beforeEach(() => {
  setActivePinia(createPinia());
  api.get.mockReset();
  api.get.mockResolvedValue({ data: {} });
  api.put.mockReset();
  api.post.mockReset();
  valuesCheck = Promise.withResolvers<unknown>();
  api.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/import/inspect')) {
      return {
        data: {
          headers: ['Email Address'],
          sampleValues: [['ana-vendor@example.com']],
          rowCount: 1,
          targets: [{ key: 'applicant_email', label: 'Email', required: true, kind: 'identity' }],
          groups: [],
          suggestedMapping: { applicant_email: 0 },
        },
      };
    }
    if (url.endsWith('/import/preview')) return valuesCheck.promise;
    return { data: { created: 1, phase: MarketPhase.Applications } };
  });
  open.refresh.mockReset();
  open.refresh.mockResolvedValue(undefined);
  open.market = ref(MARKET);
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
  answerLeaveQuestion(false);
  wrapper?.unmount();
  wrapper = null;
});

async function onMapColumns(): Promise<VueWrapper> {
  wrapper = mount(CsvImportView, {
    global: { stubs: { MarketFrame: { template: '<div><slot /></div>' }, AmendFormDialog: true } },
    attachTo: document.body,
  });
  const input = wrapper.get('[data-testid="import-file-input"]');
  const file = new File([FILE], 'responses.csv', { type: 'text/csv' });
  Object.defineProperty(input.element, 'files', { value: [file] });
  await input.trigger('change');
  await flushPromises();
  expect(wrapper.find('[data-testid="import-map"]').exists()).toBe(true);
  return wrapper;
}

async function press(view: VueWrapper, testid: string) {
  await view.get(`[data-testid="${testid}"]`).trigger('click');
  await flushPromises();
}

/** Back pressed as a person would: a click on a disabled button does nothing in a browser. */
async function pressBackIfOffered(view: VueWrapper) {
  const back = view.get<HTMLButtonElement>('[data-testid="import-back-button"]');
  if (!back.element.disabled) await press(view, 'import-back-button');
}

/** The bodies the import itself was posted with. */
function importBodies(): Array<{ csvContent?: string }> {
  return api.post.mock.calls
    .filter(([url]) => String(url).endsWith('/applications/import'))
    .map(([, body]) => body as { csvContent?: string });
}

describe('Back during the values check', () => {
  it('is refused while the values check is out', async () => {
    const view = await onMapColumns();
    await press(view, 'import-preview-button');
    const back = view.get<HTMLButtonElement>('[data-testid="import-back-button"]');
    expect(back.element.disabled).toBe(true);
  });

  it("leaves the check's late answer no way to open Preview without a file", async () => {
    const view = await onMapColumns();
    await press(view, 'import-preview-button');
    await pressBackIfOffered(view);
    valuesCheck.resolve({ data: { validRows: 1, newRows: 1 } });
    await flushPromises();
    // Either Back was refused and the answer opened Preview with the file, or Back went to Upload
    // and the answer was dropped; never Preview without a file.
    const onPreview = view.find('[data-testid="import-preview"]').exists();
    if (onPreview) expect(view.find('[data-testid="import-filename"]').exists()).toBe(true);
    else expect(view.find('[data-testid="import-upload"]').exists()).toBe(true);
  });

  it('leaves Import no way to post an empty file', async () => {
    const view = await onMapColumns();
    await press(view, 'import-preview-button');
    await pressBackIfOffered(view);
    valuesCheck.resolve({ data: { validRows: 1, newRows: 1 } });
    await flushPromises();
    const confirm = view.find<HTMLButtonElement>('[data-testid="import-confirm-button"]');
    if (confirm.exists() && !confirm.element.disabled) await press(view, 'import-confirm-button');
    for (const body of importBodies()) expect(body.csvContent).toBe(FILE);
  });
});

describe('Start over while a request is out', () => {
  it('drops the form read "Add a question for it" sent, so no dialog opens over Upload', async () => {
    const view = await onMapColumns();
    const formRead = Promise.withResolvers<unknown>();
    api.get.mockImplementation(async (url: string) =>
      url.endsWith('/application-form') ? formRead.promise : { data: {} },
    );
    const select = view.get<HTMLSelectElement>('[data-testid="import-target-select-0"]');
    select.element.value = '__needs_a_field__';
    await select.trigger('change');
    await flushPromises();
    await press(view, 'import-add-a-field-button');
    // Nothing marks the form read as busy, so Back is offered: Start over.
    await press(view, 'import-back-button');
    expect(view.find('[data-testid="import-upload"]').exists()).toBe(true);
    formRead.resolve({ data: { application_form: { fields: [] }, formRevision: 1 } });
    await flushPromises();
    expect(view.findComponent({ name: 'AmendFormDialog' }).props('open')).toBe(false);
  });
});

describe('the steps carry their data', () => {
  /** The bodies the values check was posted with. */
  function checkBodies(): Array<{ mapping?: Record<string, unknown> }> {
    return api.post.mock.calls
      .filter(([url]) => String(url).endsWith('/import/preview'))
      .map(([, body]) => body as { mapping?: Record<string, unknown> });
  }

  it("a column changed during the check offers Preview import again, and the check's answer leaves Map columns as it is", async () => {
    const served = api.post.getMockImplementation()!;
    api.post.mockImplementation(async (url: string, body: unknown) =>
      url.endsWith('/import/inspect')
        ? {
            data: {
              headers: ['Email Address', 'Notes'],
              sampleValues: [['ana-vendor@example.com'], ['Corner table']],
              rowCount: 1,
              targets: [
                { key: 'applicant_email', label: 'Email', required: true, kind: 'identity' },
                { key: 'notes', label: 'Notes', required: false, kind: 'custom' },
              ],
              groups: [],
              suggestedMapping: { applicant_email: 0 },
            },
          }
        : served(url, body),
    );
    const view = await onMapColumns();
    await press(view, 'import-preview-button');
    const preview = view.get<HTMLButtonElement>('[data-testid="import-preview-button"]');
    expect(preview.element.disabled).toBe(true);

    const select = view.get<HTMLSelectElement>('[data-testid="import-target-select-1"]');
    select.element.value = 'notes';
    await select.trigger('change');
    await flushPromises();
    expect(preview.element.disabled).toBe(false);
    expect(preview.text()).toBe('Preview import');

    // The answer was for the mapping before the change: it opens nothing.
    valuesCheck.resolve({ data: { validRows: 1, newRows: 1 } });
    await flushPromises();
    expect(view.find('[data-testid="import-map"]').exists()).toBe(true);
    expect(view.find('[data-testid="import-preview"]').exists()).toBe(false);
    expect(select.element.value).toBe('notes');

    // Checked again, the preview is the mapping on screen.
    await press(view, 'import-preview-button');
    expect(view.find('[data-testid="import-preview"]').exists()).toBe(true);
    expect(checkBodies().at(-1)?.mapping).toEqual({ applicant_email: 0, notes: 1 });
  });

  describe("the amend dialog's form read never ends the step's own request", () => {
    /** Two columns, "Notes" optional, so a check can go out with it at "nowhere to go". */
    function servesANotesColumn(extraTargets: unknown[] = []) {
      const served = api.post.getMockImplementation()!;
      api.post.mockImplementation(async (url: string, body: unknown) =>
        url.endsWith('/import/inspect')
          ? {
              data: {
                headers: ['Email Address', 'Notes'],
                sampleValues: [['ana-vendor@example.com'], ['Corner table']],
                rowCount: 1,
                targets: [
                  { key: 'applicant_email', label: 'Email', required: true, kind: 'identity' },
                  ...extraTargets,
                ],
                groups: [],
                suggestedMapping: { applicant_email: 0 },
              },
            }
          : served(url, body),
      );
    }

    async function nowhereToGo(view: VueWrapper) {
      const select = view.get<HTMLSelectElement>('[data-testid="import-target-select-1"]');
      select.element.value = '__needs_a_field__';
      await select.trigger('change');
      await flushPromises();
    }

    /** "Add a question for it" pressed as a person would: a disabled button does nothing. */
    async function addAQuestionIfOffered(view: VueWrapper) {
      const add = view.get<HTMLButtonElement>('[data-testid="import-add-a-field-button"]');
      if (!add.element.disabled) await press(view, 'import-add-a-field-button');
    }

    it('a form read refused during the values check leaves the check to answer', async () => {
      servesANotesColumn();
      const view = await onMapColumns();
      await nowhereToGo(view);
      api.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/application-form')) throw new Error('Network Error');
        return { data: {} };
      });
      await press(view, 'import-preview-button');
      expect(
        view.get<HTMLButtonElement>('[data-testid="import-add-a-field-button"]').element.disabled,
      ).toBe(true);
      await addAQuestionIfOffered(view);
      valuesCheck.resolve({ data: { validRows: 1, newRows: 1 } });
      await flushPromises();
      expect(view.find('[data-testid="import-preview"]').exists()).toBe(true);
    });

    it('a form read answered during the values check opens no dialog over it', async () => {
      servesANotesColumn();
      const view = await onMapColumns();
      await nowhereToGo(view);
      api.get.mockImplementation(async (url: string) =>
        url.endsWith('/application-form')
          ? { data: { application_form: { fields: [] }, formRevision: 1 } }
          : { data: {} },
      );
      await press(view, 'import-preview-button');
      await addAQuestionIfOffered(view);
      const dialog = view.findComponent({ name: 'AmendFormDialog' });
      expect(dialog.props('open')).toBe(false);
      valuesCheck.resolve({ data: { validRows: 1, newRows: 1 } });
      await flushPromises();
      expect(view.find('[data-testid="import-preview"]').exists()).toBe(true);
      expect(dialog.props('open')).toBe(false);
    });

    it("a form read refused during a re-read leaves the re-read's answer to land", async () => {
      servesANotesColumn();
      const view = await onMapColumns();
      await nowhereToGo(view);
      api.get.mockImplementation(async (url: string) =>
        url.endsWith('/application-form')
          ? { data: { application_form: { fields: [] }, formRevision: 1 } }
          : { data: {} },
      );
      await press(view, 'import-add-a-field-button');
      const dialog = view.findComponent({ name: 'AmendFormDialog' });
      expect(dialog.props('open')).toBe(true);

      // The question is saved: the form now has a Notes target, read again with the file.
      const reread = Promise.withResolvers<unknown>();
      const served = api.post.getMockImplementation()!;
      api.post.mockImplementation(async (url: string, body: unknown) =>
        url.endsWith('/import/inspect') ? reread.promise : served(url, body),
      );
      dialog.vm.$emit('close');
      dialog.vm.$emit('amended');
      await flushPromises();
      expect(
        view.get<HTMLButtonElement>('[data-testid="import-add-a-field-button"]').element.disabled,
      ).toBe(true);
      api.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/application-form')) throw new Error('Network Error');
        return { data: {} };
      });
      await addAQuestionIfOffered(view);
      reread.resolve({
        data: {
          headers: ['Email Address', 'Notes'],
          sampleValues: [['ana-vendor@example.com'], ['Corner table']],
          rowCount: 1,
          targets: [
            { key: 'applicant_email', label: 'Email', required: true, kind: 'identity' },
            { key: 'notes', label: 'Notes', required: false, kind: 'custom' },
          ],
          groups: [],
          suggestedMapping: { applicant_email: 0, notes: 1 },
        },
      });
      // The values read beside the re-read answers too.
      valuesCheck.resolve({ data: {} });
      await flushPromises();
      const options = view
        .get<HTMLSelectElement>('[data-testid="import-target-select-1"]')
        .findAll('option')
        .map((option) => option.element.value);
      expect(options).toContain('notes');
    });
  });

  it('a file the server could not read leaves Upload naming no file', async () => {
    api.post.mockRejectedValue(new Error('Network Error'));
    wrapper = mount(CsvImportView, {
      global: {
        stubs: { MarketFrame: { template: '<div><slot /></div>' }, AmendFormDialog: true },
      },
      attachTo: document.body,
    });
    const input = wrapper.get('[data-testid="import-file-input"]');
    const file = new File([FILE], 'responses.csv', { type: 'text/csv' });
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    await flushPromises();
    expect(wrapper.find('[data-testid="import-upload"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-filename"]').exists()).toBe(false);
  });
});
