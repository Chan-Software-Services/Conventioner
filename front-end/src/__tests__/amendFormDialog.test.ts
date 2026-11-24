import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { AxiosError } from 'axios';

import AmendFormDialog from '@/components/application/AmendFormDialog.vue';
import { MARKET_CHANGED_CODE } from '@/utils/api';
import { EMPTY_ESSENTIAL_OPTIONS } from '@/utils/essentialFields';

const api = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const SENTENCE =
  'This market changed while you were working on it, so your change was not saved. ' +
  'Reload to see the latest, then make your change again.';
const SHOP = {
  key: 'shop_name',
  label: 'Shop',
  type: 'text',
  required: false,
  options: [],
  order: 0,
};

beforeEach(() => {
  api.put.mockReset();
});

describe('AmendFormDialog', () => {
  it('refuses a key the import reads as something else before anything is sent (E38/F02)', async () => {
    const wrapper = mount(AmendFormDialog, {
      props: {
        open: true,
        marketId: 'market-1',
        applicationForm: { fields: [] },
        formRevision: 0,
        essentialOptions: EMPTY_ESSENTIAL_OPTIONS,
        suggestedFieldLabel: 'Submitted at',
        intakeIsForm: false,
      },
      global: { stubs: { teleport: true } },
    });
    await wrapper.vm.$nextTick();

    expect(
      (wrapper.get('[data-testid="amend-form-key-input"]').element as HTMLInputElement).value,
    ).toBe('submitted_at');
    expect(wrapper.get('[data-testid="amend-form-key-error"]').text()).toBe(
      'Key "submitted_at" is reserved: the import reads that column as when they applied. Choose another key.',
    );
    // The error grows the dialog as a key is typed, so its top is held rather than its centre.
    expect(wrapper.get('.dialog-container').classes()).toContain('dialog-container--anchored');
  });

  it('names each question it can stop asking, never its key', async () => {
    const wrapper = mount(AmendFormDialog, {
      props: {
        open: true,
        marketId: 'market-1',
        applicationForm: { fields: [] },
        formRevision: 0,
        essentialOptions: EMPTY_ESSENTIAL_OPTIONS,
        intakeIsForm: false,
      },
      global: { stubs: { teleport: true } },
    });
    await wrapper.vm.$nextTick();

    const toggle = wrapper.get('[data-testid="amend-form-unask-essential_request"]');
    expect(toggle.text()).toBe('Stop asking Anything else you need from us?');
  });

  describe('a form that would ask nothing', () => {
    /** A plan that offers two sections and no dates, and a form with no question of its own. */
    const TWO_SECTIONS = { ...EMPTY_ESSENTIAL_OPTIONS, sections: ['Hall A', 'Hall B'] };

    function mountOnTwoSections() {
      return mount(AmendFormDialog, {
        props: {
          open: true,
          marketId: 'market-1',
          applicationForm: { fields: [] },
          formRevision: 0,
          essentialOptions: TWO_SECTIONS,
        },
        global: { stubs: { teleport: true } },
      });
    }

    it('says so at once when the last question the plan asks is turned off, as the move to Review refuses it', async () => {
      const wrapper = mountOnTwoSections();
      await wrapper.vm.$nextTick();
      expect(wrapper.find('[data-testid="amend-form-asks-nothing"]').exists()).toBe(false);

      // Only the name and the business name are left, which every form asks: they ask nothing
      // the plan offers, so they are not a form that asks something.
      await wrapper
        .get('[data-testid="amend-form-unask-essential_section_ranking"] input')
        .setValue(true);
      await wrapper.get('[data-testid="amend-form-unask-essential_request"] input').setValue(true);

      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').text()).toBe(
        'That would leave the form asking nothing about what this market offers, so it could not ' +
          'enter Review. Keep asking Section preference, or add a question.',
      );
      // A refusal of the save, so it reads red.
      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').classes()).toEqual([
        'amend-error',
      ]);
      expect(
        wrapper.get('[data-testid="amend-form-submit-button"]').attributes('disabled'),
      ).toBeDefined();
    });

    it('counts the free request as asking nothing, as the server does', async () => {
      const wrapper = mountOnTwoSections();
      await wrapper.vm.$nextTick();

      // The request is still asked, but it applies for nothing the plan offers.
      await wrapper
        .get('[data-testid="amend-form-unask-essential_section_ranking"] input')
        .setValue(true);
      expect(
        (
          wrapper.get('[data-testid="amend-form-unask-essential_request"] input')
            .element as HTMLInputElement
        ).checked,
      ).toBe(false);

      // So the remedy is the question the plan offers, never "keep one" while one is kept.
      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').text()).toBe(
        'That would leave the form asking nothing about what this market offers, so it could not ' +
          'enter Review. Keep asking Section preference, or add a question.',
      );
      expect(
        wrapper.get('[data-testid="amend-form-submit-button"]').attributes('disabled'),
      ).toBeDefined();
    });

    it('names every question the plan offers that would clear it', async () => {
      const wrapper = mount(AmendFormDialog, {
        props: {
          open: true,
          marketId: 'market-1',
          applicationForm: { fields: [] },
          formRevision: 0,
          essentialOptions: { ...TWO_SECTIONS, tableTypes: ['Full', 'Half'] },
          suggestedUnasked: 'essential_section_ranking',
        },
        global: { stubs: { teleport: true } },
      });
      await wrapper.vm.$nextTick();
      await wrapper
        .get('[data-testid="amend-form-unask-essential_table_type_ranking"] input')
        .setValue(true);

      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').text()).toBe(
        'That would leave the form asking nothing about what this market offers, so it could not ' +
          'enter Review. Keep asking Section preference or Table type preference, or add a question.',
      );
    });

    it('says nothing once a question is added', async () => {
      const wrapper = mountOnTwoSections();
      await wrapper.vm.$nextTick();
      await wrapper
        .get('[data-testid="amend-form-unask-essential_section_ranking"] input')
        .setValue(true);

      await wrapper.get('[data-testid="amend-form-label-input"]').setValue('What do you sell?');

      expect(wrapper.find('[data-testid="amend-form-asks-nothing"]').exists()).toBe(false);
      expect(
        wrapper.get('[data-testid="amend-form-submit-button"]').attributes('disabled'),
      ).toBeUndefined();
    });
  });

  describe('a form that already asks nothing', () => {
    /** A plan that offers nothing to ask about: no dates, no tiers, one section. */
    const NOTHING_OFFERED = { ...EMPTY_ESSENTIAL_OPTIONS, sections: ['Hall A'] };

    function mountOnNothingOffered() {
      return mount(AmendFormDialog, {
        props: {
          open: true,
          marketId: 'market-1',
          applicationForm: { fields: [] },
          formRevision: 0,
          essentialOptions: NOTHING_OFFERED,
        },
        global: { stubs: { teleport: true } },
      });
    }

    it('says what is already true as it opens, and that only a question clears it', async () => {
      const wrapper = mountOnNothingOffered();
      await wrapper.vm.$nextTick();

      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').text()).toBe(
        'The form asks nothing about what this market offers, so it cannot enter Review until ' +
          'you add a question.',
      );
    });

    it('saves a change that only stops asking the request, as the server takes it', async () => {
      api.put.mockResolvedValue({ data: { application_form: { fields: [] }, formRevision: 1 } });
      const wrapper = mountOnNothingOffered();
      await wrapper.vm.$nextTick();

      await wrapper.get('[data-testid="amend-form-unask-essential_request"] input').setValue(true);

      // Still a warning: the move to Review refuses the form, the save does not. So it reads in
      // the warning's yellow, never the refusal's red.
      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').classes()).toEqual([
        'amend-warning',
      ]);
      expect(
        wrapper.get('[data-testid="amend-form-submit-button"]').attributes('disabled'),
      ).toBeUndefined();
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(api.put).toHaveBeenCalledTimes(1);
      expect(api.put.mock.calls[0]![1].unaskedEssentials).toEqual(['essential_request']);
      expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('names the question it stopped asking as the way back', async () => {
      const wrapper = mount(AmendFormDialog, {
        props: {
          open: true,
          marketId: 'market-1',
          applicationForm: { fields: [], unaskedEssentials: ['essential_section_ranking'] },
          formRevision: 0,
          essentialOptions: { ...EMPTY_ESSENTIAL_OPTIONS, sections: ['Hall A', 'Hall B'] },
        },
        global: { stubs: { teleport: true } },
      });
      await wrapper.vm.$nextTick();

      expect(wrapper.get('[data-testid="amend-form-asks-nothing"]').text()).toBe(
        'The form asks nothing about what this market offers, so it cannot enter Review. Ask ' +
          'Section preference again, or add a question.',
      );
    });
  });

  /** Mounted to add a question for a column with nowhere to go, then saved. */
  async function saveANewQuestion() {
    const wrapper = mountTheDialog();
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-testid="amend-form-submit-button"]').trigger('submit');
    await flushPromises();
    return wrapper;
  }

  function mountTheDialog() {
    return mount(AmendFormDialog, {
      props: {
        open: true,
        marketId: 'market-1',
        applicationForm: { fields: [SHOP] },
        formRevision: 3,
        essentialOptions: EMPTY_ESSENTIAL_OPTIONS,
        suggestedFieldLabel: 'Website',
      },
      global: { stubs: { teleport: true } },
    });
  }

  it('holds while it saves, and saves once however often it is pressed (T411)', async () => {
    const saved = Promise.withResolvers<unknown>();
    api.put.mockReturnValue(saved.promise);
    const wrapper = mountTheDialog();
    await wrapper.vm.$nextTick();

    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    await wrapper.get('[data-testid="amend-form-cancel-button"]').trigger('click');
    await wrapper.get('[data-testid="amend-form-close-button"]').trigger('click');
    await wrapper.get('[data-testid="amend-form-background"]').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();

    expect(wrapper.emitted('close')).toBeUndefined();
    expect(
      wrapper.get('[data-testid="amend-form-submit-button"]').attributes('disabled'),
    ).toBeDefined();
    expect(api.put).toHaveBeenCalledTimes(1);

    saved.resolve({ data: { application_form: { fields: [SHOP] } } });
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('keeps a save answered after a close and a new opening out of that opening (T411)', async () => {
    const saved = Promise.withResolvers<unknown>();
    api.put.mockReturnValue(saved.promise);
    const wrapper = mountTheDialog();
    await wrapper.vm.$nextTick();
    await wrapper.get('form').trigger('submit');

    // The import closes it on another market, and opens it there.
    await wrapper.setProps({ open: false, marketId: 'market-2' });
    await wrapper.setProps({ open: true });
    saved.reject(
      Object.assign(new AxiosError('refused'), {
        response: { status: 409, data: { error: SENTENCE, code: MARKET_CHANGED_CODE } },
      }),
    );
    await flushPromises();

    expect(wrapper.find('[data-testid="amend-form-error"]').exists()).toBe(false);
    expect(wrapper.emitted('changed')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(
      wrapper.get('[data-testid="amend-form-submit-button"]').attributes('disabled'),
    ).toBeUndefined();
  });

  it('sends the revision of the form it read with its save (ADR 0024)', async () => {
    api.put.mockResolvedValue({ data: { application_form: { fields: [SHOP] }, formRevision: 4 } });

    const wrapper = await saveANewQuestion();

    expect(api.put).toHaveBeenCalledTimes(1);
    const [url, body] = api.put.mock.calls[0]!;
    expect(url).toBe('/markets/market-1/application-form');
    expect(body.formRevision).toBe(3);
    expect(body.fields.map((f: { key: string }) => f.key)).toEqual(['shop_name', 'website']);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('a save refused as the market changed says so, stays open and asks for the form again', async () => {
    api.put.mockRejectedValue(
      Object.assign(new AxiosError('refused'), {
        response: { status: 409, data: { error: SENTENCE, code: MARKET_CHANGED_CODE } },
      }),
    );

    const wrapper = await saveANewQuestion();

    expect(wrapper.get('[data-testid="amend-form-error"]').text()).toBe(SENTENCE);
    expect(wrapper.emitted('changed')).toHaveLength(1);
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.emitted('amended')).toBeUndefined();
  });

  it('saves again from the form as re-read, its unasked questions included, not the copy refused', async () => {
    api.put
      .mockRejectedValueOnce(
        Object.assign(new AxiosError('refused'), {
          response: { status: 409, data: { error: SENTENCE, code: MARKET_CHANGED_CODE } },
        }),
      )
      .mockResolvedValueOnce({ data: { application_form: { fields: [SHOP] }, formRevision: 3 } });
    const wrapper = mount(AmendFormDialog, {
      props: {
        open: true,
        marketId: 'market-1',
        applicationForm: { fields: [SHOP], unaskedEssentials: [] },
        formRevision: 1,
        essentialOptions: EMPTY_ESSENTIAL_OPTIONS,
        suggestedFieldLabel: 'Website',
      },
      global: { stubs: { teleport: true } },
    });
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-testid="amend-form-submit-button"]').trigger('submit');
    await flushPromises();

    // The import reads the form again: a colleague stopped asking the request meanwhile.
    await wrapper.setProps({
      applicationForm: { fields: [SHOP], unaskedEssentials: ['essential_request'] },
      formRevision: 2,
    });
    expect(
      (
        wrapper.get('[data-testid="amend-form-unask-essential_request"] input')
          .element as HTMLInputElement
      ).checked,
    ).toBe(true);
    await wrapper.get('[data-testid="amend-form-submit-button"]').trigger('submit');
    await flushPromises();

    expect(api.put).toHaveBeenCalledTimes(2);
    const body = api.put.mock.calls[1]![1];
    expect(body.formRevision).toBe(2);
    expect(body.unaskedEssentials).toEqual(['essential_request']);
    expect(body.fields.map((f: { key: string }) => f.key)).toEqual(['shop_name', 'website']);
  });
});
