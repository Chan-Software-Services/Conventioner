/**
 * Every form asks a built-in business name (T502, ADR 0042).
 *
 * `front-end/src/utils/essentialFields.ts` mirrors `back-end/essential_fields.py`: the key and the
 * label below are the back end's, written out, so the mirror fails here when the two drift. The
 * answer is stored only when one was given, so every reader goes through `businessName`, which
 * reads an absent key, an organizer's blank update and anything that is not text as none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import EssentialApplicationFields from '@/components/application/EssentialApplicationFields.vue';
import EssentialFieldsPanel from '@/components/application/EssentialFieldsPanel.vue';
import UpdateInfoDialog from '@/components/UpdateInfoDialog.vue';
import {
  ApplicationStatus,
  ApplicationType,
  type AnswerUpdate,
  type Application,
  type EssentialFormOptions,
} from '@/assets/types/datatypes';
import {
  BUSINESS_NAME_KEY,
  BUSINESS_NAME_LABEL,
  ESSENTIAL_KEYS,
  FULL_NAME_KEY,
  PREFERRED_NAME_KEY,
  UNASKABLE_ESSENTIAL_KEYS,
  applicantName,
  applicationAnswerRows,
  askedEssentialAnswers,
  businessName,
  essentialValidationErrors,
  planDerivedAskedKeys,
} from '@/utils/essentialFields';
import { ASSIGNMENT_READS } from '@/utils/answerUpdates';
import { findsApplication } from '@/utils/reviewQueue';
import { servedReview } from './support/servedReview';

const sent: { url: string; body: unknown }[] = [];

vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return {
    ...actual,
    api: {
      put: (url: string, body: { answers: Record<string, unknown> }) => {
        sent.push({ url, body });
        return Promise.resolve({ data: { application: application() } });
      },
    },
  };
});

afterEach(() => {
  sent.length = 0;
});

const NO_PLAN: EssentialFormOptions = {
  dates: [],
  sections: [],
  tableTypes: [],
  tiers: [],
  unasked: [],
};

const testid = (id: string) => `[data-testid="${id}"]`;

describe('the mirror agrees with the back end', () => {
  it('uses the key and the label the server uses', () => {
    expect(BUSINESS_NAME_KEY).toBe('essential_business_name');
    expect(BUSINESS_NAME_LABEL).toBe('Business name');
  });

  it('asks it right after the preferred name', () => {
    expect(ESSENTIAL_KEYS.indexOf(BUSINESS_NAME_KEY)).toBe(
      ESSENTIAL_KEYS.indexOf(PREFERRED_NAME_KEY) + 1,
    );
  });

  it('asks it of every market, one with no plan included, and never as what is applied for', () => {
    expect(askedEssentialAnswers(NO_PLAN)).toContainEqual({
      key: BUSINESS_NAME_KEY,
      label: 'Business name',
    });
    expect(planDerivedAskedKeys(NO_PLAN)).not.toContain(BUSINESS_NAME_KEY);
  });

  it('lets no market leave it unasked, and is no answer the assignment reads', () => {
    expect(UNASKABLE_ESSENTIAL_KEYS).not.toContain(BUSINESS_NAME_KEY);
    expect(ASSIGNMENT_READS).not.toContain(BUSINESS_NAME_KEY);
  });

  it('never refuses an applicant for it', () => {
    const errors = essentialValidationErrors(NO_PLAN, { [FULL_NAME_KEY]: 'Ana Rivera' });

    expect(errors).toEqual({});
  });
});

describe('the business name of some answers', () => {
  it.each([
    ['no such key', {}],
    ['an empty one', { [BUSINESS_NAME_KEY]: '' }],
    ['only spaces', { [BUSINESS_NAME_KEY]: '   ' }],
    ['null', { [BUSINESS_NAME_KEY]: null }],
    ['a number', { [BUSINESS_NAME_KEY]: 7 }],
    ['a list', { [BUSINESS_NAME_KEY]: ['Paper & Pine'] }],
  ])('is none for %s', (_what, answers) => {
    expect(businessName(answers)).toBe('');
  });

  it('is none for no answers at all', () => {
    expect(businessName(null)).toBe('');
    expect(businessName(undefined)).toBe('');
  });

  it('is the one given, without the space around it', () => {
    expect(businessName({ [BUSINESS_NAME_KEY]: ' Paper & Pine ' })).toBe('Paper & Pine');
  });

  it('is never the name a vendor is called by', () => {
    expect(
      applicantName({ [FULL_NAME_KEY]: 'Ana Rivera', [BUSINESS_NAME_KEY]: 'Paper & Pine' }),
    ).toBe('Ana Rivera');
  });
});

describe('the answers read back', () => {
  it('list the business name under its label, after the preferred name', () => {
    const { essential } = applicationAnswerRows({
      [BUSINESS_NAME_KEY]: 'Paper & Pine',
      [PREFERRED_NAME_KEY]: 'Annie',
      [FULL_NAME_KEY]: 'Ana Rivera',
    });

    expect(essential.map((row) => [row.label, row.value])).toEqual([
      ['Full name', 'Ana Rivera'],
      ['Preferred name', 'Annie'],
      ['Business name', 'Paper & Pine'],
    ]);
  });

  it('list no row for a vendor who gave none', () => {
    const { essential } = applicationAnswerRows({ [FULL_NAME_KEY]: 'Ana Rivera' });

    expect(essential.map((row) => row.key)).toEqual([FULL_NAME_KEY]);
  });
});

describe('the applicant form', () => {
  function form(modelValue: Record<string, unknown> = {}) {
    return mount(EssentialApplicationFields, {
      props: { options: NO_PLAN, modelValue, prefix: 'apply' },
    });
  }

  it('draws it right after the preferred name, with its help text', () => {
    const wrapper = form();
    const order = wrapper
      .findAll('.essential-field')
      .map((field) => field.attributes('data-testid'));
    const field = wrapper.get(testid('apply-essential-business-name'));

    expect(order.indexOf('apply-essential-business-name')).toBe(
      order.indexOf('apply-essential-preferred-name') + 1,
    );
    expect(field.get('label').text()).toBe('Business name');
    expect(field.get('label').attributes('for')).toBe('apply-essential-business-name-input');
    expect(field.get('.essential-help').text()).toBe(
      'The name of your business or stall, if you trade under one. Leave it empty if you do not.',
    );
    expect(wrapper.get(testid('apply-essential-business-name-input')).attributes()).toMatchObject({
      type: 'text',
      autocomplete: 'organization',
    });
  });

  it('shows the one already given, and sends what is typed', async () => {
    const wrapper = form({ [BUSINESS_NAME_KEY]: 'Paper & Pine' });
    const input = wrapper.get(testid('apply-essential-business-name-input'));

    expect((input.element as HTMLInputElement).value).toBe('Paper & Pine');
    await input.setValue('Pine & Paper');

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([
      { [BUSINESS_NAME_KEY]: 'Pine & Paper' },
    ]);
    expect(wrapper.emitted('field-change')?.at(-1)).toEqual([BUSINESS_NAME_KEY]);
  });

  it('is read-only where its question is locked', () => {
    const wrapper = mount(EssentialApplicationFields, {
      props: { options: NO_PLAN, modelValue: {}, prefix: 'apply', locked: [BUSINESS_NAME_KEY] },
    });

    expect(
      wrapper.get(testid('apply-essential-business-name-input')).attributes('disabled'),
    ).toBeDefined();
  });
});

describe("the form editor's built-in questions", () => {
  it('list it after the preferred name, with no "Ask this" tick', () => {
    const panel = mount(EssentialFieldsPanel, { props: { options: NO_PLAN } });
    const items = panel.findAll('.essential-item').map((item) => item.attributes('data-testid'));
    const item = panel.get(testid('essential-item-business-name'));

    expect(items.indexOf('essential-item-business-name')).toBe(
      items.indexOf('essential-item-preferred-name') + 1,
    );
    expect(item.text()).toContain('Business name');
    expect(item.text()).toContain('Optional');
    expect(item.find('input').exists()).toBe(false);
  });
});

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: 'app-1',
    marketId: 'market-123',
    applicantEmail: 'ana@example.com',
    formData: { [FULL_NAME_KEY]: 'Ana Rivera', [BUSINESS_NAME_KEY]: 'Paper & Pine' },
    status: ApplicationStatus.ReviewerApproved,
    ...servedReview('approved'),
    applicationType: ApplicationType.Main,
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('Update info', () => {
  function dialog(app: Application = application(), assignmentRefusal: string | null = null) {
    return mount(UpdateInfoDialog, {
      props: {
        open: true,
        marketId: 'market-123',
        application: app,
        form: { fields: [] },
        options: NO_PLAN,
        assignmentRefusal,
      },
      attachTo: document.body,
    });
  }
  const INPUT = testid('update-info-essential-business-name-input');

  async function save(wrapper: ReturnType<typeof dialog>) {
    await wrapper.get('form').trigger('submit');
    await flushPromises();
  }

  it('corrects one, saying what they wrote beside it', async () => {
    const wrapper = dialog();

    await wrapper.get(INPUT).setValue('Paper and Pine');

    expect(wrapper.get(testid(`update-info-theirs-${BUSINESS_NAME_KEY}`)).text()).toContain(
      'Paper & Pine',
    );
    await save(wrapper);
    expect(sent[0].body).toEqual({ answers: { [BUSINESS_NAME_KEY]: 'Paper and Pine' } });
    wrapper.unmount();
  });

  it('blanks one, sending it empty', async () => {
    const wrapper = dialog();

    await wrapper.get(INPUT).setValue('');
    await save(wrapper);

    expect(sent[0].body).toEqual({ answers: { [BUSINESS_NAME_KEY]: '' } });
    wrapper.unmount();
  });

  it('sets one for a vendor who gave none, who is said to have written nothing', async () => {
    const wrapper = dialog(application({ formData: { [FULL_NAME_KEY]: 'Ana Rivera' } }));

    expect((wrapper.get(INPUT).element as HTMLInputElement).value).toBe('');
    await wrapper.get(INPUT).setValue('Paper & Pine');

    expect(wrapper.get(testid(`update-info-theirs-${BUSINESS_NAME_KEY}`)).text()).toContain(
      'Nothing',
    );
    await save(wrapper);
    expect(sent[0].body).toEqual({ answers: { [BUSINESS_NAME_KEY]: 'Paper & Pine' } });
    wrapper.unmount();
  });

  it('has nothing to save when one typed for a vendor who gave none is erased again', async () => {
    const wrapper = dialog(application({ formData: { [FULL_NAME_KEY]: 'Ana Rivera' } }));

    await wrapper.get(INPUT).setValue('Paper');
    await wrapper.get(INPUT).setValue('');

    expect(wrapper.get(testid('update-info-submit-button')).attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('puts their answer back over a blank update', async () => {
    const update: AnswerUpdate = {
      value: '',
      by: { userId: 'u1', email: 'sam@example.com' },
      at: '2026-10-30T17:04:00+00:00',
      over: 'Paper & Pine',
      theyWrote: 'Paper & Pine',
      changedSince: false,
    };
    const wrapper = dialog(
      application({
        formData: { [FULL_NAME_KEY]: 'Ana Rivera', [BUSINESS_NAME_KEY]: '' },
        answerUpdates: { [BUSINESS_NAME_KEY]: update },
      }),
    );

    await wrapper.get(testid(`update-info-use-theirs-${BUSINESS_NAME_KEY}`)).trigger('click');
    await save(wrapper);

    expect(sent[0].body).toEqual({ answers: { [BUSINESS_NAME_KEY]: 'Paper & Pine' } });
    wrapper.unmount();
  });

  it('is open to whoever may not update what the assignment reads', () => {
    const wrapper = dialog(application(), 'Only an Admin or the owner may update those.');

    expect(wrapper.get(INPUT).attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('the review search', () => {
  const ana = {
    applicantEmail: 'ana@example.com',
    formData: { [FULL_NAME_KEY]: 'Ana Rivera', [BUSINESS_NAME_KEY]: 'Paper & Pine' },
  };

  it('finds an application by its business name, capitals aside', () => {
    expect(findsApplication(ana, 'paper & p')).toBe(true);
    expect(findsApplication(ana, 'thistle')).toBe(false);
  });

  it('finds nobody by a business name they do not have', () => {
    const none = { applicantEmail: 'ben@example.com', formData: { [FULL_NAME_KEY]: 'Ben Okafor' } };

    expect(findsApplication(none, 'undefined')).toBe(false);
    expect(findsApplication(none, 'ben')).toBe(true);
  });
});
