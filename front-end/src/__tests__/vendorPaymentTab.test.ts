/**
 * The drawer's Payment tab (E44/F01/S01): a line per table-day, the payments, the totals and how
 * they compare; "Record payment" only for whoever the row allows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import postcss from 'postcss';
import { parse as parseSfc } from 'vue/compiler-sfc';
import ChangeOwedDialog from '@/components/ChangeOwedDialog.vue';
import VendorPaymentTab from '@/components/VendorPaymentTab.vue';
import type { VendorAccount } from '@/utils/payments';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/api')>();
  return { ...actual, api };
});

const LINE = {
  tableCode: 'North Wing 1',
  tier: 'Gold',
  tableChoice: 'Full Table',
  priceCents: 3500,
  owedCents: 3500,
  owedSetBy: null,
  owedSetAt: null,
  freed: false,
  freedAt: null,
  freedBy: null,
};

const ACCOUNT: VendorAccount = {
  currency: 'CAD',
  lines: [
    { ...LINE, date: '2099-05-07' },
    {
      ...LINE,
      date: '2099-05-08',
      freed: true,
      freedAt: '2099-04-20T12:00:00+00:00',
      freedBy: 'editor@example.com',
    },
  ],
  payments: [
    {
      id: 'p1',
      kind: 'payment',
      cents: 3500,
      method: 'cash',
      paidOn: '2099-04-01',
      note: 'At the info desk',
      recordedBy: 'editor@example.com',
      recordedAt: '2099-04-01T18:00:00+00:00',
      editedBy: null,
      editedAt: null,
      removedBy: null,
      removedAt: null,
    },
  ],
  owedCents: 7000,
  paidCents: 3500,
  balanceState: 'owes',
  compares: true,
};

async function tab(
  canRecord: boolean,
  account: VendorAccount = ACCOUNT,
  admin: { canChangeOwed?: boolean; canAdjustPaid?: boolean } = {},
) {
  api.get.mockResolvedValue({ data: account });
  const wrapper = mount(VendorPaymentTab, {
    props: { marketId: 'market-1', email: 'ana@example.com', canRecord, ...admin },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

describe('the Payment tab', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.delete.mockReset();
  });

  it('reads one vendor’s account', async () => {
    await tab(true);

    expect(api.get).toHaveBeenCalledWith('/markets/market-1/payments/ana%40example.com');
  });

  it('heads the tab with both totals and how they compare', async () => {
    const wrapper = await tab(true);

    expect(wrapper.get('[data-testid="payment-owed"]').text()).toBe('$70.00');
    expect(wrapper.get('[data-testid="payment-paid"]').text()).toBe('$35.00');
    expect(wrapper.get('[data-testid="payment-balance"]').text()).toBe('Owes $35.00');
  });

  it('tones and marks the chip by the state the server serves, not by its own reading', async () => {
    // Owing $70.00 with $35.00 paid, but served as paid in full: the tab keeps no copy of the rule.
    const wrapper = await tab(true, { ...ACCOUNT, balanceState: 'paid' });

    const chip = wrapper.get('[data-testid="payment-balance"]');
    expect(chip.attributes('data-state')).toBe('paid');
    expect(chip.classes()).toContain('chip--positive');
    expect(chip.text()).toBe('Paid in full');
  });

  it.each([
    ['owes', 'chip--attention'],
    ['over', 'chip--informational'],
    [null, 'chip--neutral'],
  ] as const)('marks a chip served %s', async (balanceState, chip) => {
    const wrapper = await tab(true, { ...ACCOUNT, balanceState });

    const balance = wrapper.get('[data-testid="payment-balance"]');
    expect(balance.attributes('data-state')).toBe(balanceState ?? 'none');
    expect(balance.classes()).toContain(chip);
  });

  it('keeps a freed table’s line, still owed, saying it was freed and when', async () => {
    const wrapper = await tab(true);

    const lines = wrapper.findAll('[data-testid="payment-line"]');
    expect(lines).toHaveLength(2);
    expect(lines[0].get('[data-testid="payment-line-source"]').text()).toBe(
      'North Wing 1, Gold, full table',
    );
    expect(lines[1].get('[data-testid="payment-line-source"]').text()).toBe(
      'North Wing 1, Gold, full table - table freed Apr 20, 2099',
    );
    expect(lines[1].get('[data-testid="payment-line-owed"]').text()).toBe('$35.00');
  });

  it('says who recorded each payment', async () => {
    const wrapper = await tab(true);

    const entry = wrapper.get('[data-testid="payment-entry"]');
    expect(entry.text()).toContain('Cash, paid');
    expect(entry.text()).toContain('At the info desk');
    expect(entry.get('[data-testid="payment-entry-who"]').text()).toContain(
      'Recorded by editor@example.com',
    );
  });

  it('offers Record payment to whoever the row allows, and no one else', async () => {
    expect((await tab(true)).find('[data-testid="payment-record"]').exists()).toBe(true);
    expect((await tab(false)).find('[data-testid="payment-record"]').exists()).toBe(false);
  });

  it('records a payment and reads the account it answers', async () => {
    const wrapper = await tab(true);
    api.post.mockResolvedValue({ data: { ...ACCOUNT, paidCents: 7000, balanceState: 'paid' } });

    await wrapper.get('[data-testid="payment-record"]').trigger('click');
    await flushPromises();
    const amount = document.querySelector<HTMLInputElement>(
      '[data-testid="record-payment-amount"]',
    );
    amount!.value = '35';
    amount!.dispatchEvent(new Event('input'));
    document.querySelector<HTMLInputElement>('[data-testid="record-payment-method-cash"]')!.click();
    await flushPromises();
    document
      .querySelector<HTMLButtonElement>('[data-testid="record-payment-submit-button"]')!
      .click();
    await flushPromises();

    expect(api.post).toHaveBeenCalledWith(
      '/markets/market-1/payments/ana%40example.com',
      expect.objectContaining({ cents: 3500, method: 'cash', note: '' }),
    );
    expect(wrapper.get('[data-testid="payment-balance"]').text()).toBe('Paid in full');
    expect(document.querySelector('[data-testid="record-payment-window"]')).toBeNull();
    wrapper.unmount();
  });

  it('says a vendor with no table owes nothing', async () => {
    const wrapper = await tab(false, {
      currency: 'CAD',
      lines: [],
      payments: [],
      owedCents: 0,
      paidCents: 0,
      balanceState: null,
      compares: true,
    });

    expect(wrapper.text()).toContain('No table yet, so nothing is owed.');
    expect(wrapper.text()).toContain('No payments recorded.');
    expect(wrapper.get('[data-testid="payment-balance"]').text()).toBe('Nothing owed');
  });

  it('offers an Editor neither menu nor Record refund', async () => {
    const wrapper = await tab(true);

    expect(wrapper.find('[data-testid="payment-line-menu-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="payment-entry-menu-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="payment-refund"]').exists()).toBe(false);
  });

  it('offers an Admin each line’s menu, each entry’s menu and Record refund', async () => {
    const wrapper = await tab(true, ACCOUNT, { canChangeOwed: true, canAdjustPaid: true });

    expect(wrapper.findAll('[data-testid="payment-line-menu-button"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="payment-entry-menu-button"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="payment-refund"]').exists()).toBe(true);
    await wrapper.findAll('[data-testid="payment-line-menu-button"]')[0].trigger('click');
    expect(wrapper.get('[data-testid="payment-line-menu"]').text()).toBe('Change the amount owed');
    wrapper.unmount();
  });

  it('shows an amount set by hand beside the calculated price struck, with who and when', async () => {
    const wrapper = await tab(
      true,
      {
        ...ACCOUNT,
        lines: [
          {
            ...ACCOUNT.lines[0],
            owedCents: 0,
            owedSetBy: 'admin@example.com',
            owedSetAt: '2099-04-02T12:00:00+00:00',
          },
        ],
        owedCents: 0,
      },
      { canChangeOwed: true },
    );

    const line = wrapper.get('[data-testid="payment-line"]');
    expect(line.get('[data-testid="payment-line-price"]').text()).toBe('$35.00');
    expect(line.get('[data-testid="payment-line-owed"]').text()).toBe('$0.00');
    expect(line.get('[data-testid="payment-line-set"]').text()).toContain(
      'Set by admin@example.com, Apr 2, 2099',
    );
    await line.get('[data-testid="payment-line-menu-button"]').trigger('click');
    expect(line.get('[data-testid="payment-line-menu"]').text()).toContain(
      'Use the calculated price',
    );
    wrapper.unmount();
  });

  it('tells a free’s deduction apart from an amount set by hand (review, note 19)', async () => {
    const wrapper = await tab(true, {
      ...ACCOUNT,
      lines: [
        {
          ...ACCOUNT.lines[1],
          owedCents: 0,
          owedSetBy: 'admin@example.com',
          owedSetAt: '2099-04-21T12:00:00+00:00',
          owedByFree: true,
        },
      ],
      owedCents: 0,
    });

    expect(wrapper.get('[data-testid="payment-line-set"]').text()).toContain(
      'Removed when the table was freed, by admin@example.com',
    );
  });

  it('lists a removed entry as removed, by whom, and offers it no menu', async () => {
    const wrapper = await tab(
      true,
      {
        ...ACCOUNT,
        payments: [
          {
            ...ACCOUNT.payments[0],
            removedBy: 'admin@example.com',
            removedAt: '2099-04-02T12:00:00+00:00',
          },
        ],
        paidCents: 0,
      },
      { canAdjustPaid: true },
    );

    const entry = wrapper.get('[data-testid="payment-entry"]');
    // Who recorded it still reads, and the removal under it (review 2, note 9).
    expect(entry.get('[data-testid="payment-entry-who"]').text()).toContain(
      'Recorded by editor@example.com',
    );
    expect(entry.get('[data-testid="payment-entry-change"]').text()).toContain(
      'Removed by admin@example.com',
    );
    expect(entry.get('[data-testid="payment-entry-amount"]').element.tagName).toBe('S');
    expect(entry.find('[data-testid="payment-entry-menu-button"]').exists()).toBe(false);
  });

  it('keeps a removal refused as changed meanwhile open, with the account as it stands behind it', async () => {
    const changed =
      'This payment changed while it was being removed, so it was not removed. It now reads as shown behind this: close this and remove it again if it should still go.';
    const asItStands: VendorAccount = {
      ...ACCOUNT,
      payments: [
        {
          ...ACCOUNT.payments[0],
          cents: 2000,
          editedBy: 'other-admin@example.com',
          editedAt: '2099-04-02T12:00:00+00:00',
        },
      ],
      paidCents: 2000,
    };
    const wrapper = await tab(true, ACCOUNT, { canAdjustPaid: true });
    api.delete.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: changed, account: asItStands } },
      }),
    );

    await wrapper.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await wrapper.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    document
      .querySelector<HTMLFormElement>('[data-testid="payment-confirm-window"] form')!
      .requestSubmit();
    await flushPromises();

    expect(api.delete).toHaveBeenCalledWith('/markets/market-1/payment-entries/p1');
    expect(document.querySelector('[data-testid="payment-confirm-window"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="payment-confirm-error"]')?.textContent).toBe(
      changed,
    );
    expect(wrapper.get('[data-testid="payment-paid"]').text()).toBe('$20.00');
    expect(wrapper.get('[data-testid="payment-entry-amount"]').text()).toBe('$20.00');
    expect(wrapper.emitted('changed')).toHaveLength(1);

    // It still reads the $35.00 it was opened on, so it removes nothing more until opened again.
    const remove = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="payment-confirm-submit-button"]')!;
    expect(remove().disabled).toBe(true);
    document
      .querySelector<HTMLFormElement>('[data-testid="payment-confirm-window"] form')!
      .requestSubmit();
    await flushPromises();
    expect(api.delete).toHaveBeenCalledTimes(1);

    document
      .querySelector<HTMLButtonElement>('[data-testid="payment-confirm-cancel-button"]')!
      .click();
    await flushPromises();
    await wrapper.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await wrapper.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="payment-confirm-body"]')?.textContent).toContain(
      '$20.00',
    );
    expect(remove().disabled).toBe(false);
    wrapper.unmount();
  });

  it('keeps a removal refused with no account open, and the account as it was', async () => {
    const wrapper = await tab(true, ACCOUNT, { canAdjustPaid: true });
    api.delete.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 404'), {
        isAxiosError: true,
        response: { status: 404, data: { error: 'This market has no such payment standing.' } },
      }),
    );

    await wrapper.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await wrapper.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    document
      .querySelector<HTMLFormElement>('[data-testid="payment-confirm-window"] form')!
      .requestSubmit();
    await flushPromises();

    expect(document.querySelector('[data-testid="payment-confirm-error"]')?.textContent).toBe(
      'This market has no such payment standing.',
    );
    expect(wrapper.get('[data-testid="payment-paid"]').text()).toBe('$35.00');
    expect(wrapper.emitted('changed')).toBeUndefined();
    wrapper.unmount();
  });

  it('holds a removal while it removes, and sends one for two presses', async () => {
    let answer!: (value: { data: VendorAccount }) => void;
    api.delete.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const wrapper = await tab(true, ACCOUNT, { canAdjustPaid: true });
    await wrapper.get('[data-testid="payment-entry-menu-button"]').trigger('click');
    await wrapper.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
    await flushPromises();
    const form = document.querySelector<HTMLFormElement>(
      '[data-testid="payment-confirm-window"] form',
    )!;

    form.requestSubmit();
    form.requestSubmit();
    await flushPromises();

    expect(api.delete).toHaveBeenCalledTimes(1);
    const button = (name: string) =>
      document.querySelector<HTMLButtonElement>(`[data-testid="payment-confirm-${name}-button"]`)!;
    expect(button('submit').disabled).toBe(true);
    expect(button('submit').textContent?.trim()).toBe('Saving…');
    expect(button('cancel').disabled).toBe(true);
    button('cancel').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.querySelector('[data-testid="payment-confirm-window"]')).not.toBeNull();

    answer({ data: { ...ACCOUNT, payments: [], paidCents: 0 } });
    await flushPromises();
    expect(document.querySelector('[data-testid="payment-confirm-window"]')).toBeNull();
    expect(wrapper.get('[data-testid="payment-paid"]').text()).toBe('$0.00');
    wrapper.unmount();
  });

  it('opens a confirmation afresh after a refusal, with no word of it', async () => {
    const wrapper = await tab(true, ACCOUNT, { canAdjustPaid: true });
    api.delete.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 404'), {
        isAxiosError: true,
        response: { status: 404, data: { error: 'This market has no such payment standing.' } },
      }),
    );
    const openRemove = async () => {
      await wrapper.get('[data-testid="payment-entry-menu-button"]').trigger('click');
      await wrapper.get('[data-testid="payment-entry-menu-remove"]').trigger('click');
      await flushPromises();
    };
    await openRemove();
    document
      .querySelector<HTMLFormElement>('[data-testid="payment-confirm-window"] form')!
      .requestSubmit();
    await flushPromises();
    expect(document.querySelector('[data-testid="payment-confirm-error"]')).not.toBeNull();

    document
      .querySelector<HTMLButtonElement>('[data-testid="payment-confirm-cancel-button"]')!
      .click();
    await flushPromises();
    await openRemove();

    expect(document.querySelector('[data-testid="payment-confirm-error"]')).toBeNull();
    wrapper.unmount();
  });

  it("shows an earlier opening's change behind Change the amount owed, which stays open", async () => {
    const wrapper = await tab(true, ACCOUNT, { canChangeOwed: true });
    await wrapper.findAll('[data-testid="payment-line-menu-button"]')[0].trigger('click');
    await wrapper.get('[data-testid="payment-line-menu-owed"]').trigger('click');
    await flushPromises();

    // The dialog hands on an earlier opening's answer as the account as it stands.
    wrapper
      .findComponent(ChangeOwedDialog)
      .vm.$emit('refreshed', { ...ACCOUNT, owedCents: 3500, balanceState: 'paid' });
    await flushPromises();

    expect(wrapper.get('[data-testid="payment-owed"]').text()).toBe('$35.00');
    expect(document.querySelector('[data-testid="change-owed-window"]')).not.toBeNull();
    expect(wrapper.emitted('changed')).toHaveLength(1);
    wrapper.unmount();
  });
});

/**
 * Each part of the tab set apart (Daniel's release walk of 2026-11-17): the totals, "Table-days" and
 * "Payments" each a card, and inside them each table-day and each payment a box of its own, even
 * when it is the only one, so its "..." menu sits with it.
 *
 * The look is read from the component's own styles, as `aRefusalReadsRed.test.ts` reads its: happy-dom
 * applies none, so a mounted tab measures nothing; `the-payment-tab.spec.ts` measures it laid out.
 */
describe('the Payment tab’s cards and boxes', () => {
  const rules = (() => {
    const { descriptor } = parseSfc(
      readFileSync(resolvePath(process.cwd(), 'src/components/VendorPaymentTab.vue'), 'utf8'),
    );
    const found: { selectors: string[]; decls: Record<string, string> }[] = [];
    for (const style of descriptor.styles) {
      postcss.parse(style.content).walkRules((rule) => {
        if (rule.parent?.type !== 'root') return;
        const decls: Record<string, string> = {};
        rule.walkDecls((decl) => {
          decls[decl.prop] = decl.value;
        });
        found.push({ selectors: rule.selectors, decls });
      });
    }
    return found;
  })();

  /** What the styles give `selector`, by every rule that names it alone, the last one winning. */
  function styleOf(selector: string): Record<string, string> {
    return Object.assign(
      {},
      ...rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.decls),
    );
  }

  const CARD = {
    padding: 'var(--space-4)',
    border: '1px solid var(--mm-border)',
    'border-radius': 'var(--radius-card)',
  };
  const BOX = {
    padding: 'var(--space-2) var(--space-3)',
    border: '1px solid var(--mm-border)',
    'border-radius': 'var(--radius-control)',
  };

  it('sets the totals and each group apart as cards, a card’s gap apart', () => {
    expect(styleOf('.payment-tab')).toMatchObject({ gap: 'var(--space-4)' });
    expect(styleOf('.payment-totals')).toMatchObject(CARD);
    expect(styleOf('.payment-group')).toMatchObject(CARD);
  });

  it('boxes each table-day and each payment, a box’s gap apart', () => {
    expect(styleOf('.payment-list')).toMatchObject({ gap: 'var(--space-2)' });
    expect(styleOf('.payment-line')).toMatchObject(BOX);
    expect(styleOf('.payment-entry')).toMatchObject(BOX);
  });

  it('takes no edge or inset from a box by where it stands in its list, so one alone is boxed too', () => {
    const byPlace = rules.filter((rule) =>
      rule.selectors.some((selector) =>
        /\.payment-(line|entry)\S*:(first|last|only|nth)/.test(selector),
      ),
    );
    expect(byPlace.map((rule) => rule.selectors.join(', '))).toEqual([]);
  });

  it('draws a lone table-day and a lone payment each in its box, its menu inside it', async () => {
    const wrapper = await tab(
      true,
      { ...ACCOUNT, lines: [ACCOUNT.lines[0]] },
      {
        canChangeOwed: true,
        canAdjustPaid: true,
      },
    );

    for (const [card, item, menu] of [
      ['payment-days', 'payment-line', 'payment-line-menu-button'],
      ['payment-payments', 'payment-entry', 'payment-entry-menu-button'],
    ]) {
      const boxes = wrapper.get(`[data-testid="${card}"]`).findAll(`[data-testid="${item}"]`);
      expect(boxes).toHaveLength(1);
      expect(boxes[0].classes()).toContain(item);
      expect(boxes[0].find(`[data-testid="${menu}"]`).exists()).toBe(true);
    }
    wrapper.unmount();
  });

  it('moves a date whole, else breaks it only after its weekday, never parting a month from its day', async () => {
    const wrapper = await tab(true);
    const line = wrapper.findAll('[data-testid="payment-line"]')[0];
    const entry = wrapper.findAll('[data-testid="payment-entry"]')[0];

    // A table-day's date, and a payment's paid day after what it was.
    expect(line.get('.payment-line-date').text()).toBe('Thursday, May 7, 2099');
    expect(line.get('[data-testid="payment-line-day"]').text()).toBe('May 7, 2099');
    expect(entry.get('.payment-entry-what').text()).toBe('Cash, paid Wednesday, April 1, 2099');
    expect(entry.get('[data-testid="payment-entry-day"]').text()).toBe('April 1, 2099');
    expect(entry.get('[data-testid="payment-entry-date"]').text()).toBe('Wednesday, April 1, 2099');
    expect(styleOf('.payment-date')).toMatchObject({ display: 'inline-block' });
    expect(styleOf('.payment-day')).toMatchObject({ 'white-space': 'nowrap' });
    wrapper.unmount();
  });
});
